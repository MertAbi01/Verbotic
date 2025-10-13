import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Send, Loader2, Mic, Volume2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useVoiceRecording } from "@/hooks/useVoiceRecording";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";

interface Message {
  id: string;
  role: string;
  content: string;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
}

const Chat = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(id || null);
  const [ragEnabled, setRagEnabled] = useState(true);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("default");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { isRecording, isProcessing, startRecording, stopRecording } = useVoiceRecording();
  const { speak } = useTextToSpeech();
  const [autoPlayTTS, setAutoPlayTTS] = useState(true);

  useEffect(() => {
    fetchAgents();
    if (conversationId) {
      fetchMessages();
      fetchConversationSettings();
    }
  }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchAgents = async () => {
    try {
      const { data, error } = await supabase
        .from("agents")
        .select("id, name")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setAgents(data || []);
    } catch (error: any) {
      console.error("Error fetching agents:", error);
    }
  };

  const fetchConversationSettings = async () => {
    if (!conversationId) return;

    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("agent_id, rag_enabled")
        .eq("id", conversationId)
        .single();

      if (error) throw error;
      if (data) {
        setRagEnabled(data.rag_enabled);
        setSelectedAgentId(data.agent_id || "default");
      }
    } catch (error: any) {
      console.error("Error fetching conversation settings:", error);
    }
  };

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
            agent_id: selectedAgentId === "default" ? null : selectedAgentId,
            rag_enabled: ragEnabled,
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

  const updateConversationSettings = async (convId: string) => {
    try {
      const { error } = await supabase
        .from("conversations")
        .update({
          agent_id: selectedAgentId === "default" ? null : selectedAgentId,
          rag_enabled: ragEnabled,
        })
        .eq("id", convId);

      if (error) throw error;
    } catch (error: any) {
      console.error("Error updating conversation settings:", error);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    setLoading(true);
    const userMessage = input;
    setInput("");

    // Optimistically show user message immediately
    const tempUserId = `temp-user-${Date.now()}`;
    const userMsg = {
      id: tempUserId,
      role: "user",
      content: userMessage,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    try {
      let currentConvId = conversationId;

      if (!currentConvId) {
        currentConvId = await createConversation();
        if (!currentConvId) throw new Error("Failed to create conversation");
        setConversationId(currentConvId);
      }

      // Add user message to database
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

      // Update conversation settings
      await updateConversationSettings(currentConvId);

      // Show loading indicator for assistant
      const tempAssistantId = `temp-assistant-${Date.now()}`;
      const loadingMsg = {
        id: tempAssistantId,
        role: "assistant",
        content: "...",
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, loadingMsg]);

      // Call RAG function
      const { data: ragData, error: ragError } = await supabase.functions.invoke("rag-chat", {
        body: {
          message: userMessage,
          conversation_id: currentConvId,
          rag_enabled: ragEnabled,
        },
      });

      if (ragError) throw ragError;

      // Update assistant message with response
      setMessages(prev => 
        prev.map(msg => 
          msg.id === tempAssistantId 
            ? { ...msg, content: ragData.response }
            : msg
        )
      );

      // Add assistant message to database
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

      // Refresh messages from database to get real IDs
      await fetchMessages();

      // Auto-play TTS for assistant response
      if (autoPlayTTS && ragData.response) {
        speak(ragData.response).catch(err => {
          console.error('TTS error:', err);
          // Don't show toast for TTS errors, just log them
        });
      }
    } catch (error: any) {
      // Remove optimistic messages on error
      setMessages(prev => prev.filter(msg => !msg.id.startsWith('temp-')));
      
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleVoiceInput = async () => {
    if (isRecording) {
      const transcription = await stopRecording();
      if (transcription) {
        setInput(transcription);
      }
    } else {
      startRecording();
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card p-4">
        <div className="container mx-auto">
          <div className="flex items-center gap-4 mb-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">Chat</h1>
          </div>
          
          <div className="flex flex-wrap gap-4 items-center">
            <div className="flex items-center space-x-2">
              <Switch
                id="rag-toggle"
                checked={ragEnabled}
                onCheckedChange={setRagEnabled}
              />
              <Label htmlFor="rag-toggle" className="text-sm">
                {ragEnabled ? "🟢 RAG Active" : "⚪ RAG Inactive"}
              </Label>
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="tts-toggle"
                checked={autoPlayTTS}
                onCheckedChange={setAutoPlayTTS}
              />
              <Label htmlFor="tts-toggle" className="text-sm">
                {autoPlayTTS ? "🔊 TTS Auto" : "🔇 TTS Manual"}
              </Label>
            </div>

            {agents.length > 0 && (
              <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
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
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap flex-1">{msg.content}</p>
                {msg.role === "assistant" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 flex-shrink-0"
                    onClick={() => speak(msg.content)}
                  >
                    <Volume2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </Card>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer className="border-t border-border bg-card p-4">
        <div className="container mx-auto max-w-3xl">
          <div className="flex gap-2">
            <Button
              variant={isRecording ? "destructive" : "secondary"}
              size="icon"
              onClick={handleVoiceInput}
              disabled={loading || isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mic className={`h-4 w-4 ${isRecording ? 'animate-pulse' : ''}`} />
              )}
            </Button>
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleSend()}
              placeholder="Nachricht eingeben oder Mikrofon verwenden..."
              disabled={loading || isProcessing}
            />
            <Button onClick={handleSend} disabled={loading || isProcessing}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Chat;
