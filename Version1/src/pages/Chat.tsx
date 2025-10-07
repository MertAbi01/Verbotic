import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ArrowLeft, Send, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

const Chat = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(id || null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (conversationId) {
      fetchMessages();
    }
  }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchMessages = async () => {
    if (!conversationId) return;

    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const createConversation = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const { data, error } = await supabase
        .from("conversations")
        .insert([
          {
            user_id: user.id,
            title: `Chat ${new Date().toLocaleDateString()}`,
          },
        ])
        .select()
        .single();

      if (error) throw error;
      return data.id;
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
      return null;
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    setLoading(true);
    const userMessage = input;
    setInput("");

    try {
      let currentConvId = conversationId;

      if (!currentConvId) {
        currentConvId = await createConversation();
        if (!currentConvId) throw new Error("Failed to create conversation");
        setConversationId(currentConvId);
      }

      // Add user message
      const { error: userMsgError } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: currentConvId,
            role: "user",
            content: userMessage,
          },
        ]);

      if (userMsgError) throw userMsgError;

      // Call RAG function
      const { data: ragData, error: ragError } = await supabase.functions.invoke("rag-chat", {
        body: {
          message: userMessage,
          conversation_id: currentConvId,
        },
      });

      if (ragError) throw ragError;

      // Add assistant message
      const { error: assistantMsgError } = await supabase
        .from("messages")
        .insert([
          {
            conversation_id: currentConvId,
            role: "assistant",
            content: ragData.response,
          },
        ]);

      if (assistantMsgError) throw assistantMsgError;

      await fetchMessages();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card p-4">
        <div className="container mx-auto flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-bold">Chat</h1>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-4">
        <div className="container mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <Card className="p-8 text-center">
              <p className="text-muted-foreground">
                Start a conversation by typing a message below
              </p>
            </Card>
          )}

          {messages.map((msg) => (
            <Card
              key={msg.id}
              className={`p-4 ${
                msg.role === "user"
                  ? "ml-auto max-w-[80%] bg-primary text-primary-foreground"
                  : "mr-auto max-w-[80%]"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </Card>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="border-t border-border bg-card p-4">
        <div className="container mx-auto max-w-3xl">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSend()}
              placeholder="Type your message..."
              disabled={loading}
            />
            <Button onClick={handleSend} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Chat;
