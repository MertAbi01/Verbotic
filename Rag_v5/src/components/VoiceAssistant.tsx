import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { X, Mic, MicOff, Volume2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { GeminiAudioRecorder, AudioQueue, encodeAudioForAPI } from "@/utils/RealtimeAudio";

interface VoiceAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | null;
  ragEnabled: boolean;
}

interface GeminiMessage {
  role: "user" | "model";
  parts: Array<{ text?: string }>;
}

const VoiceAssistant = ({ isOpen, onClose, conversationId, ragEnabled }: VoiceAssistantProps) => {
  const { toast } = useToast();
  const [isConnected, setIsConnected] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioRecorderRef = useRef<GeminiAudioRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 3;
  const currentResponseRef = useRef<string>("");
  const conversationHistoryRef = useRef<GeminiMessage[]>([]);

  useEffect(() => {
    if (isOpen && !isConnected) {
      connectToVoiceAssistant();
    }

    return () => {
      disconnect();
    };
  }, [isOpen]);

  const connectToVoiceAssistant = async () => {
    try {
      console.log("🎯 Starting connection to Gemini Voice Assistant...");

      // Request microphone access first
      await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("✅ Microphone access granted");

      // Initialize audio context and queue for 16kHz (Gemini requirement)
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
        console.log("✅ Audio context initialized (16kHz)");
      }
      if (!audioQueueRef.current) {
        audioQueueRef.current = new AudioQueue(audioContextRef.current, 16000);
        console.log("✅ Audio queue initialized");
      }

      // Get API key and config from our backend
      console.log("📡 Requesting Gemini config from backend...");
      const { data: configData, error: configError } = await supabase.functions.invoke("gemini-realtime", {
        body: {
          conversation_id: conversationId,
          rag_enabled: ragEnabled,
        },
      });

      if (configError || !configData?.api_key) {
        throw new Error(configError?.message || "Failed to get Gemini config");
      }

      console.log("✅ Gemini config received");
      const { api_key, system_instruction, model } = configData;

      // Connect to Gemini Realtime API
      console.log("🔌 Connecting to Gemini Realtime API...");
      const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${api_key}`;
      wsRef.current = new WebSocket(geminiWsUrl);

      wsRef.current.onopen = async () => {
        console.log("✅ Connected to Gemini Realtime API");
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;

        // Send setup message with audio output enabled
        const setupMessage = {
          setup: {
            model: `models/${model}`,
            generation_config: {
              response_modalities: ["AUDIO"],
                speech_config: {
                  voice_config: {
                    prebuilt_voice_config: {
                      voice_name: "Aoede"
                    }
                  }
                }
            },
            system_instruction: {
              parts: [{ text: system_instruction }],
            },
          },
        };

        console.log("📤 Sending setup message with audio output enabled...");
        wsRef.current?.send(JSON.stringify(setupMessage));

        // Start audio recording
        await startAudioRecording();

        toast({
          title: "Verbunden",
          description: "Gemini Voice Assistant ist bereit",
        });
      };

      wsRef.current.onmessage = async (event) => {
        try {
          // Handle binary data (Blob) from WebSocket
          let textData: string;
          if (event.data instanceof Blob) {
            textData = await event.data.text();
          } else {
            textData = event.data;
          }
          
          const data = JSON.parse(textData);
          console.log("📨 Received:", data);

          // Handle setup complete
          if (data.setupComplete) {
            console.log("✅ Setup complete");
          }

          // Handle server content (audio and text responses)
          if (data.serverContent) {
            const serverContent = data.serverContent;

            // Handle audio data
            if (serverContent.modelTurn?.parts) {
              for (const part of serverContent.modelTurn.parts) {
                if (part.inlineData?.mimeType?.includes("audio/pcm")) {
                  setIsSpeaking(true);
                  console.log("🔊 Receiving audio chunk, size:", part.inlineData.data.length);
                  
                  try {
                    const binaryString = atob(part.inlineData.data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                      bytes[i] = binaryString.charCodeAt(i);
                    }
                    console.log("🔊 Audio chunk decoded, size:", bytes.length, "bytes");
                    await audioQueueRef.current?.addToQueue(bytes);
                  } catch (error) {
                    console.error("❌ Error decoding audio:", error);
                  }
                }

                // Handle text in model response
                if (part.text) {
                  currentResponseRef.current += part.text;
                }
              }
            }

            // When turn is complete, add to transcript
            if (serverContent.turnComplete) {
              console.log("✅ Turn complete, stopping speaking state");
              setIsSpeaking(false);
              if (currentResponseRef.current) {
                setTranscript((prev) => [...prev, `Assistent: ${currentResponseRef.current}`]);
                conversationHistoryRef.current.push({
                  role: "model",
                  parts: [{ text: currentResponseRef.current }],
                });
                console.log("💬 Response text:", currentResponseRef.current);
                currentResponseRef.current = "";
              }
            }

            // Handle user turn for transcription
            if (serverContent.interrupted) {
              setIsListening(false);
            }
          }

          // Handle tool calls if needed
          if (data.toolCall) {
            console.log("🔧 Tool call received:", data.toolCall);
          }
        } catch (error) {
          console.error("Error processing message:", error);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
        toast({
          title: "Verbindungsfehler",
          description: "Verbindung zum Voice Assistant fehlgeschlagen",
          variant: "destructive",
        });
      };

      wsRef.current.onclose = (event) => {
        console.log("🔌 WebSocket closed:", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });

        setIsConnected(false);
        setIsSpeaking(false);
        setIsListening(false);
        stopAudioRecording();

        // Attempt reconnection if not a normal closure
        if (event.code !== 1000 && reconnectAttemptsRef.current < maxReconnectAttempts && isOpen) {
          reconnectAttemptsRef.current++;
          console.log(`🔄 Attempting reconnection ${reconnectAttemptsRef.current}/${maxReconnectAttempts}...`);

          toast({
            title: "Verbindung unterbrochen",
            description: `Versuche erneut zu verbinden (${reconnectAttemptsRef.current}/${maxReconnectAttempts})...`,
          });

          reconnectTimeoutRef.current = setTimeout(() => {
            if (isOpen) {
              connectToVoiceAssistant();
            }
          }, 2000 * reconnectAttemptsRef.current);
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          toast({
            title: "Verbindung fehlgeschlagen",
            description: "Maximale Anzahl von Wiederverbindungsversuchen erreicht. Bitte schließen und erneut öffnen.",
            variant: "destructive",
          });
        }
      };
    } catch (error) {
      console.error("Connection error:", error);
      toast({
        title: "Fehler",
        description: error instanceof Error ? error.message : "Verbindung fehlgeschlagen",
        variant: "destructive",
      });
    }
  };

  const startAudioRecording = async () => {
    if (audioRecorderRef.current) return;

    audioRecorderRef.current = new GeminiAudioRecorder((audioData) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        setIsListening(true);
        const base64Audio = encodeAudioForAPI(audioData);

        // Send realtime input to Gemini
        const realtimeInput = {
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64Audio,
              },
            ],
          },
        };

        wsRef.current.send(JSON.stringify(realtimeInput));
      }
    });

    try {
      console.log("🎤 Starting audio recording...");
      await audioRecorderRef.current.start();
      console.log("✅ Audio recording started successfully");
    } catch (error) {
      console.error("❌ Failed to start audio recording:", error);
      toast({
        title: "Mikrofon-Fehler",
        description: error instanceof Error ? error.message : "Mikrofon konnte nicht gestartet werden",
        variant: "destructive",
      });
    }
  };

  const stopAudioRecording = () => {
    audioRecorderRef.current?.stop();
    audioRecorderRef.current = null;
    setIsListening(false);
  };

  const disconnect = () => {
    console.log("🔴 Disconnecting Voice Assistant...");

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopAudioRecording();
    audioQueueRef.current?.clear();
    audioContextRef.current?.close();

    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "User disconnected");
      } catch (_) {}
      wsRef.current = null;
    }

    setIsConnected(false);
    setIsSpeaking(false);
    setIsListening(false);
    reconnectAttemptsRef.current = 0;
    conversationHistoryRef.current = [];
    currentResponseRef.current = "";
  };

  const handleClose = () => {
    disconnect();
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border bg-card p-4">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold">Verbotic CONTEXA Voice Assistant</h1>
            {isConnected && (
              <div className="flex items-center gap-2">
                {isListening && (
                  <div className="flex items-center gap-2 text-primary">
                    <Mic className="h-5 w-5 animate-pulse" />
                    <span className="text-sm">Hört zu...</span>
                  </div>
                )}
                {isSpeaking && (
                  <div className="flex items-center gap-2 text-accent">
                    <Volume2 className="h-5 w-5 animate-pulse" />
                    <span className="text-sm">Spricht...</span>
                  </div>
                )}
                {!isListening && !isSpeaking && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm">Bereit</span>
                  </div>
                )}
              </div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-8">
        <div className="container mx-auto max-w-4xl">
          {/* Status Card */}
          <Card className="p-8 mb-6 text-center bg-gradient-to-br from-card to-card/50">
            <div className="mb-6">
              {isConnected ? (
                <div className="inline-flex items-center justify-center w-32 h-32 rounded-full bg-primary/10 border-4 border-primary/30 relative">
                  {isSpeaking && <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />}
                  {isListening ? (
                    <Mic className="h-16 w-16 text-primary animate-pulse" />
                  ) : (
                    <Volume2 className="h-16 w-16 text-primary" />
                  )}
                </div>
              ) : (
                <div className="inline-flex items-center justify-center w-32 h-32 rounded-full bg-muted">
                  <MicOff className="h-16 w-16 text-muted-foreground" />
                </div>
              )}
            </div>
            <h2 className="text-2xl font-bold mb-2">{isConnected ? "Verbotic CONTEXA Voice Assistant aktiv" : "Verbinde..."}</h2>
            <p className="text-muted-foreground mb-4">
              {isConnected
                ? "Sprechen Sie einfach los - der Assistent hört zu und antwortet automatisch"
                : "Bitte warten Sie, während die Verbindung hergestellt wird"}
            </p>
            {ragEnabled && (
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 rounded-full">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="text-sm font-medium">RAG aktiviert - Zugriff auf Dokumente</span>
              </div>
            )}
          </Card>

          {/* Transcript */}
          {transcript.length > 0 && (
            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4">Gesprächsverlauf</h3>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {transcript.map((text, index) => (
                  <div
                    key={index}
                    className={`p-3 rounded-lg ${text.startsWith("Sie:") ? "bg-primary/10 ml-8" : "bg-muted mr-8"}`}
                  >
                    <p className="text-sm whitespace-pre-wrap">{text}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Info Footer */}
      <div className="border-t border-border bg-card/50 p-4">
        <div className="container mx-auto max-w-4xl text-center">
          <p className="text-sm text-muted-foreground">
            💡 Powered by Verbotic - Native Audio Preview
          </p>
        </div>
      </div>
    </div>
  );
};

export default VoiceAssistant;
