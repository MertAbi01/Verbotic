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
    const { message, conversation_id } = await req.json();

    if (!message) {
      throw new Error("Message is required");
    }

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Get conversation context
    let contextDocuments: any[] = [];
    if (conversation_id) {
      const { data: conversation } = await supabase
        .from("conversations")
        .select("context_id")
        .eq("id", conversation_id)
        .single();

      if (conversation?.context_id) {
        const { data: context } = await supabase
          .from("contexts")
          .select("document_ids, system_prompt")
          .eq("id", conversation.context_id)
          .single();

        if (context?.document_ids && context.document_ids.length > 0) {
          const { data: docs } = await supabase
            .from("documents")
            .select("*")
            .in("id", context.document_ids);
          
          contextDocuments = docs || [];
        }
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

    // Build context string from documents
    let contextString = "";
    if (contextDocuments.length > 0) {
      contextString = `\n\nRelevant documents:\n${contextDocuments
        .map((doc) => `- ${doc.title}`)
        .join("\n")}`;
    }

    // Build conversation history string
    const historyString = conversationHistory
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    // Call Lovable AI
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const systemPrompt = `You are a helpful AI assistant with access to uploaded documents. 
Answer questions based on the provided context and conversation history. 
If you don't have enough information to answer accurately, say so.${contextString}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      { role: "user", content: message },
    ];

    console.log("Sending request to Lovable AI...");

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message.content;

    return new Response(
      JSON.stringify({
        response: assistantMessage,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in rag-chat function:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
