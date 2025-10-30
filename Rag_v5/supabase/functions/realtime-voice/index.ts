import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  console.error("anfang");
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

    // Fetch RAG context if enabled
    let ragContext = "";
    if (rag_enabled && conversation_id && userId) {
      try {
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
            ragContext += `\n\nAgent Instructions: ${agent.system_prompt}`;
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
            ragContext += "\n\nRelevant context documents are available for reference.";
          }
        }
      } catch (error) {
        console.error("Error fetching RAG context:", error);
      }
    }

    // Get OpenAI API key
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not configured");
    }

    // Create ephemeral token from OpenAI
    console.log("Creating ephemeral session for client...");
    const systemPrompt = `You are a helpful AI assistant. ${ragContext}`;

    const requestBody = {
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "alloy",
      instructions: systemPrompt,
    };

    console.log("Request body:", JSON.stringify(requestBody, null, 2));

    const tokenResponse = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Failed to create session:", errorText);
      throw new Error(`Failed to create OpenAI session: ${tokenResponse.status}`);
    }

    const sessionData = await tokenResponse.json();
    console.log("Session created successfully");

    // Return the ephemeral token to the client
    return new Response(
      JSON.stringify({
        client_secret: sessionData.client_secret.value,
        expires_at: sessionData.client_secret.expires_at,
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
