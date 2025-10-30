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
    const { message, conversation_id, rag_enabled } = await req.json();

    if (!message) {
      throw new Error("Message is required");
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
      await supabase.from("logs").insert([{ value: "WebSocket connection attempt222" }]);
    } catch (err) {
      console.error("Logging failed:", err);
    }

    const authHeader = req.headers.get("authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
    } = await supabase.auth.getUser(token);

    if (!user) throw new Error("Unauthorized");

    // Get conversation and agent details
    let systemPrompt = "You are a helpful AI assistant.";
    let ragEnabledForConversation = rag_enabled ?? true;
    let documentIds: string[] = [];

    if (conversation_id) {
      const { data: conversation } = await supabase
        .from("conversations")
        .select("agent_id, rag_enabled, context_id")
        .eq("id", conversation_id)
        .single();

      if (conversation) {
        ragEnabledForConversation = conversation.rag_enabled;

        // Get agent if specified - agent documents have priority
        if (conversation.agent_id) {
          const { data: agent } = await supabase
            .from("agents")
            .select("system_prompt, rag_enabled, document_ids")
            .eq("id", conversation.agent_id)
            .single();

          if (agent) {
            systemPrompt = agent.system_prompt;
            ragEnabledForConversation = agent.rag_enabled;
            documentIds = agent.document_ids || [];
            console.log("Using agent-specific documents:", documentIds);
          }
        }

        // If no agent documents, use context documents
        if (documentIds.length === 0 && ragEnabledForConversation && conversation.context_id) {
          const { data: context } = await supabase
            .from("contexts")
            .select("document_ids, system_prompt")
            .eq("id", conversation.context_id)
            .single();

          if (context) {
            if (context.system_prompt) {
              systemPrompt = context.system_prompt;
            }
            documentIds = context.document_ids || [];
            console.log("Using context documents:", documentIds);
          }
        }
      }
    }

    // Fallback: if no agent/context docs, use user's completed documents
    if (ragEnabledForConversation && documentIds.length === 0) {
      const { data: userDocs, error: userDocsError } = await supabase
        .from("documents")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "completed")
        .limit(100);

      if (userDocsError) {
        console.error("Error fetching user documents:", userDocsError);
      } else if (userDocs && userDocs.length > 0) {
        documentIds = userDocs.map((d: any) => d.id);
        console.log("Using user documents for RAG:", documentIds);
      } else {
        console.log("No completed user documents found for RAG");
      }
    }

    // Get conversation history
    let conversationHistory: any[] = [];
    if (conversation_id) {
      const { data: messages } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: true })
        .limit(10);

      conversationHistory = messages || [];
    }

    // If RAG is enabled and we have documents, perform vector search
    let relevantContext = "";
    let hasRelevantDocuments = false;
    if (ragEnabledForConversation && documentIds.length > 0) {
      const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

      if (OPENAI_API_KEY) {
        // Generate embedding for the user's message
        const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + OPENAI_API_KEY.trim(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: message,
          }),
        });

        if (embeddingResponse.ok) {
          const embeddingData = await embeddingResponse.json();
          const embedding = embeddingData.data[0].embedding;

          // Perform vector similarity search
          console.log("Performing vector search with embedding for documents:", documentIds);
          const { data: chunks, error: rpcError } = await supabase.rpc("match_document_chunks", {
            query_embedding: embedding,
            match_threshold: 0.3,
            match_count: 5,
            filter_document_ids: documentIds,
          });

          if (rpcError) {
            console.error("RPC error:", rpcError);
          }

          console.log(`Found ${chunks?.length || 0} matching chunks`);

          if (chunks && chunks.length > 0) {
            hasRelevantDocuments = true;
            relevantContext = `\n\nRelevant information from documents:\n${chunks
              .map((chunk: any) => chunk.content)
              .join("\n\n")}`;
            console.log("Using RAG context with", chunks.length, "chunks");
          } else {
            console.log("No matching chunks found");
          }
        }
      }
    }

    // Build the final system prompt
    let finalSystemPrompt = "";
    if (ragEnabledForConversation) {
      if (hasRelevantDocuments) {
        finalSystemPrompt = `${systemPrompt}${relevantContext}\n\nWICHTIG: Beantworte die Frage ausschließlich basierend auf den bereitgestellten Dokumenteninformationen. Wenn die Information nicht in den Dokumenten enthalten ist, antworte mit: "Die angefragte Information ist in den bereitgestellten Dokumenten nicht enthalten."`;
      } else if (documentIds.length > 0) {
        // RAG is enabled and documents exist, but no relevant chunks found
        return new Response(
          JSON.stringify({
            response: "Die angefragte Information ist in den bereitgestellten Dokumenten nicht enthalten.",
            rag_used: true,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      } else {
        finalSystemPrompt = `${systemPrompt}\n\nRAG is enabled but no documents are available.`;
      }
    } else {
      finalSystemPrompt = `${systemPrompt}\n\nRAG is disabled. Answer based on your general knowledge.`;
    }

    // Call OpenAI API
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const messages = [
      { role: "system", content: finalSystemPrompt },
      ...conversationHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    console.log("Sending request to OpenAI...");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENAI_API_KEY.trim(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    return new Response(
      JSON.stringify({
        response: assistantMessage,
        rag_used: ragEnabledForConversation && relevantContext !== "",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error in rag-chat function:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
