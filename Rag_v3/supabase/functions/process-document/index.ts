import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { document_id } = await req.json();

    if (!document_id) {
      throw new Error("document_id is required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get document
    const { data: document, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", document_id)
      .single();

    if (docError || !document) {
      throw new Error("Document not found");
    }

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(document.file_path);

    if (downloadError || !fileData) {
      throw new Error("Failed to download document");
    }

    // Extract text based on file type
    let text = "";
    const mime = document.mime_type;

    if (mime === "text/plain" || mime === "text/csv") {
      text = await fileData.text();
    } else if (mime === "application/pdf") {
      // For PDF, we'd need a PDF parser - simplified for now
      text = "PDF processing would require pdf-parse library";
    } else {
      text = await fileData.text();
    }

    // Split text into chunks (simple implementation)
    const chunkSize = 1000;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    // Generate embeddings and store chunks
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    let processedChunks = 0;
    for (const chunk of chunks) {
      // Generate embedding
      const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: chunk,
        }),
      });

      if (!embeddingResponse.ok) {
        console.error("Failed to generate embedding for chunk");
        continue;
      }

      const embeddingData = await embeddingResponse.json();
      const embedding = embeddingData.data[0].embedding;

      // Store chunk with embedding
      await supabase.from("document_chunks").insert({
        document_id: document_id,
        content: chunk,
        embedding: embedding,
        metadata: { chunk_index: processedChunks }
      });

      processedChunks++;

      // Update progress
      const progress = Math.round((processedChunks / chunks.length) * 100);
      await supabase
        .from("documents")
        .update({ processing_progress: progress })
        .eq("id", document_id);
    }

    // Mark as completed
    await supabase
      .from("documents")
      .update({ 
        status: "completed",
        processing_progress: 100
      })
      .eq("id", document_id);

    return new Response(
      JSON.stringify({ 
        success: true,
        chunks_processed: processedChunks 
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in process-document function:", error);
    
    // Update document with error
    const { document_id } = await req.json();
    if (document_id) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const supabase = createClient(supabaseUrl, supabaseKey);
      
      await supabase
        .from("documents")
        .update({ 
          status: "failed",
          error_message: error instanceof Error ? error.message : "Unknown error"
        })
        .eq("id", document_id);
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
