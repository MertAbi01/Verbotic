import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get user from auth header
    const authHeader = req.headers.get("authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let userId: string | null = null;
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const {
        data: { user },
      } = await supabase.auth.getUser(token);
      userId = user?.id || null;
    }

    // Get conversation_id and rag_enabled from request body
    const { conversation_id, rag_enabled } = await req.json();
    
    console.log(`RAG enabled: ${rag_enabled}, Conversation ID: ${conversation_id}, User ID: ${userId}`);

    // Fetch RAG context if enabled
    let systemInstruction = "You are a helpful assistant and answer in a friendly tone.";
    if (rag_enabled && userId) {
      console.log("Starting RAG context fetch...");
      try {
        let documentIds: string[] = [];
        let agentSystemPrompt: string | null = null;

        // If a conversation is provided, try to enrich with agent/context specifics
        if (conversation_id) {
          // Fetch conversation
          const { data: conversation } = await supabase
            .from("conversations")
            .select("agent_id, context_id")
            .eq("id", conversation_id)
            .single();

          // Fetch agent context if exists
          if (conversation?.agent_id) {
            const { data: agent } = await supabase
              .from("agents")
              .select("system_prompt, document_ids")
              .eq("id", conversation.agent_id)
              .single();

            if (agent?.system_prompt) {
              agentSystemPrompt = agent.system_prompt;
            }

            if (agent?.document_ids && agent.document_ids.length > 0) {
              documentIds = [...documentIds, ...agent.document_ids];
            }
          }

          // Fetch context documents if exists
          if (conversation?.context_id) {
            const { data: context } = await supabase
              .from("contexts")
              .select("document_ids")
              .eq("id", conversation.context_id)
              .single();

            if (context?.document_ids && context.document_ids.length > 0) {
              documentIds = [...documentIds, ...context.document_ids];
            }
          }
        }

        // Merge agent system prompt if present
        if (agentSystemPrompt) {
          systemInstruction += `\n\nAgent Instructions: ${agentSystemPrompt}`;
        }

        // If no specific documents, get user's completed documents (works even without conversation)
        if (documentIds.length === 0) {
          const { data: userDocs } = await supabase
            .from("documents")
            .select("id")
            .eq("user_id", userId)
            .eq("status", "completed")
            .order("created_at", { ascending: false })
            .limit(5);

          if (userDocs && userDocs.length > 0) {
            documentIds = userDocs.map(doc => doc.id);
          }
        }

        // Fetch document chunks from the selected documents
        if (documentIds.length > 0) {
          console.log(`Fetching chunks from ${documentIds.length} documents (IDs: ${documentIds.join(", ")})`);
          const { data: chunks, error: chunksError } = await supabase
            .from("document_chunks")
            .select("content, document_id")
            .in("document_id", documentIds)
            .limit(100); // Increased limit for better context

          if (chunksError) {
            console.error("Error fetching document chunks:", chunksError);
          } else if (chunks && chunks.length > 0) {
            console.log(`Successfully fetched ${chunks.length} document chunks for RAG context`);

            // Combine all chunks into context
            const allContent = chunks.map(chunk => chunk.content).join("\n\n");

            // Build RAG context with clear instructions for Gemini
            let ragContext = "\n\n=== WISSENSDATENBANK ===\n";
            ragContext += "Du hast Zugriff auf folgende Informationen aus hochgeladenen Dokumenten. Nutze dieses Wissen, um Fragen präzise zu beantworten:\n\n";
            ragContext += allContent;
            ragContext += "\n\n=== ENDE WISSENSDATENBANK ===\n\n";
            ragContext += "WICHTIGE ANWEISUNGEN:\n";
            ragContext += "- Nutze die Informationen aus der Wissensdatenbank, um Fragen zu beantworten\n";
            ragContext += "- Wenn die Antwort in der Wissensdatenbank zu finden ist, beziehe dich explizit darauf\n";
            ragContext += "- Wenn die Information nicht in der Wissensdatenbank enthalten ist, sage das klar und deutlich\n";
            ragContext += "- Antworte immer auf Deutsch, präzise und hilfreich\n";

            systemInstruction += ragContext;
            console.log(`Added ${allContent.length} characters of RAG context to system instruction`);
          } else {
            console.log("No document chunks found in database");
            systemInstruction += "\n\nHinweis: Die Wissensdatenbank ist verfügbar, aber momentan leer.";
          }
        } else {
          console.log("No document IDs available for RAG context");
        }
      } catch (error) {
        console.error("Error fetching RAG context:", error);
        console.error("Error details:", error instanceof Error ? error.message : String(error));
      }
    } else {
      console.log("RAG not enabled or missing required parameters (need at least user session)");
    }


    // Get Gemini API key
    const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    // Return connection info for Gemini Realtime API
    console.log("Creating Gemini session info for client...");

    return new Response(
      JSON.stringify({
        api_key: GEMINI_API_KEY,
        system_instruction: systemInstruction,
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error creating session:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
