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
    const { user_id, search_query } = await req.json();

    if (!user_id || !search_query) {
      throw new Error("user_id and search_query are required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Vector search request for user: ${user_id}, query: "${search_query}"`);

    // Get all documents for this user
    const { data: documents, error: docsError } = await supabase
      .from("documents")
      .select("id")
      .eq("user_id", user_id)
      .eq("status", "completed");

    if (docsError) {
      console.error("Error fetching user documents:", docsError);
      throw new Error("Failed to fetch user documents");
    }

    if (!documents || documents.length === 0) {
      console.log("No documents found for user");
      return new Response(
        JSON.stringify({ results: [] }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const documentIds = documents.map(doc => doc.id);
    console.log(`Found ${documentIds.length} documents for user`);

    // Generate embedding for the search query
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    console.log("Generating embedding for search query...");
    const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: search_query,
      }),
    });

    if (!embeddingResponse.ok) {
      const errorText = await embeddingResponse.text();
      console.error("OpenAI embedding error:", embeddingResponse.status, errorText);
      throw new Error(`Failed to generate embedding: ${embeddingResponse.status}`);
    }

    const embeddingData = await embeddingResponse.json();
    const embedding = embeddingData.data[0].embedding;

    console.log("Performing vector similarity search...");
    // Perform vector similarity search
    const { data: chunks, error: searchError } = await supabase.rpc('match_document_chunks', {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 5,
      filter_document_ids: documentIds
    });

    if (searchError) {
      console.error("Vector search error:", searchError);
      throw new Error("Vector search failed");
    }

    console.log(`Found ${chunks?.length || 0} relevant chunks`);

    // Format results
    const results = (chunks || []).map((chunk: any) => ({
      content: chunk.content,
      score: chunk.similarity
    }));

    return new Response(
      JSON.stringify({ results }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in chat-search function:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Unknown error",
        results: []
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
