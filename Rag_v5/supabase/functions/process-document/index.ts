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

  let document_id: string | undefined;

  try {
    const body = await req.json();
    document_id = body.document_id;

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
    console.log("Downloading file from path:", document.file_path);
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(document.file_path);

    if (downloadError) {
      console.error("Storage download error:", downloadError);
      throw new Error(`Failed to download document: ${downloadError.message}`);
    }
    
    if (!fileData) {
      throw new Error("File data is empty");
    }
    
    console.log("Downloaded file size:", fileData.size, "bytes");

    // Extract text based on file type
    let text = "";
    const mime = document.mime_type;
    const fileName = document.file_path.toLowerCase();

    console.log("Processing file type:", mime, "File name:", fileName);

    if (mime === "text/plain") {
      text = await fileData.text();
      console.log(`Extracted ${text.length} characters from TXT`);
    } else if (mime === "text/csv" || fileName.endsWith('.csv')) {
      text = await fileData.text();
      console.log(`Extracted ${text.length} characters from CSV`);
    } else if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || fileName.endsWith('.docx')) {
      try {
        console.log("Starting DOCX parsing...");
        const arrayBuffer = await fileData.arrayBuffer();
        
        // Use mammoth library for DOCX text extraction
        const { default: mammoth } = await import("https://esm.sh/mammoth@1.6.0");
        
        const result = await mammoth.extractRawText({ arrayBuffer });
        text = result.value.trim();
        
        console.log(`Extracted ${text.length} characters from DOCX`);
        
        if (!text) {
          throw new Error("No text could be extracted from DOCX");
        }
      } catch (docxError) {
        console.error("DOCX parsing error:", docxError);
        throw new Error(`Failed to parse DOCX: ${docxError instanceof Error ? docxError.message : "Unknown error"}`);
      }
    } else if (mime === "application/pdf" || fileName.endsWith('.pdf')) {
      try {
        console.log("Starting PDF parsing...");
        const arrayBuffer = await fileData.arrayBuffer();
        
        const { extractText } = await import("https://esm.sh/unpdf@0.12.1");
        
        const { text: extractedText } = await extractText(new Uint8Array(arrayBuffer));
        text = Array.isArray(extractedText) ? extractedText.join('\n\n') : String(extractedText).trim();
        
        console.log(`Extracted ${text.length} characters from PDF`);
        
        if (!text) {
          throw new Error("No text could be extracted from PDF - the document may be image-based or encrypted");
        }
      } catch (pdfError) {
        console.error("PDF parsing error:", pdfError);
        throw new Error(`Failed to parse PDF: ${pdfError instanceof Error ? pdfError.message : "Unknown error"}`);
      }
    } else {
      // Fallback for unknown types
      text = await fileData.text();
      console.log(`Extracted ${text.length} characters from unknown file type`);
    }

    // Split text into chunks (simple implementation)
    const chunkSize = 1000;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }

    // Generate embeddings and store chunks
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY || OPENAI_API_KEY.trim() === "") {
      throw new Error("OPENAI_API_KEY is not configured or is empty");
    }

    // Validate API key format
    if (typeof OPENAI_API_KEY !== 'string' || OPENAI_API_KEY.includes('\n') || OPENAI_API_KEY.includes('\r')) {
      throw new Error("OPENAI_API_KEY contains invalid characters");
    }

    let processedChunks = 0;
    for (const chunk of chunks) {
      // Generate embedding
      const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY.trim()}`,
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
    
    // Update document with error (using the document_id from outer scope)
    if (document_id) {
      try {
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
      } catch (updateError) {
        console.error("Failed to update document error status:", updateError);
      }
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
