import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Plus, Trash2, Edit, Upload, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  rag_enabled: boolean;
  document_ids: string[];
  created_at: string;
}

interface Document {
  id: string;
  title: string;
  status: string;
}

const Agents = () => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    system_prompt: "",
    rag_enabled: true,
    document_ids: [] as string[],
  });
  const [documents, setDocuments] = useState<Document[]>([]);
  const [showDocumentPicker, setShowDocumentPicker] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchAgents();
    fetchDocuments();
  }, []);

  const fetchAgents = async () => {
    try {
      const { data, error } = await supabase
        .from("agents")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setAgents(data || []);
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

  const fetchDocuments = async () => {
    try {
      const { data, error } = await supabase
        .from("documents")
        .select("id, title, status")
        .eq("status", "completed")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setDocuments(data || []);
    } catch (error: any) {
      console.error("Error fetching documents:", error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      if (editingId) {
        const { error } = await supabase
          .from("agents")
          .update(formData)
          .eq("id", editingId);

        if (error) throw error;

        toast({
          title: "Success",
          description: "Agent updated successfully",
        });
      } else {
        const { error } = await supabase.from("agents").insert([
          {
            ...formData,
            user_id: user.id,
          },
        ]);

        if (error) throw error;

        toast({
          title: "Success",
          description: "Agent created successfully",
        });
      }

      setShowForm(false);
      setEditingId(null);
      setFormData({
        name: "",
        description: "",
        system_prompt: "",
        rag_enabled: true,
        document_ids: [],
      });
      fetchAgents();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleEdit = (agent: Agent) => {
    setFormData({
      name: agent.name,
      description: agent.description || "",
      system_prompt: agent.system_prompt,
      rag_enabled: agent.rag_enabled,
      document_ids: agent.document_ids || [],
    });
    setEditingId(agent.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this agent?")) return;

    try {
      const { error } = await supabase.from("agents").delete().eq("id", id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Agent deleted successfully",
      });
      fetchAgents();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const toggleDocument = (docId: string) => {
    setFormData(prev => ({
      ...prev,
      document_ids: prev.document_ids.includes(docId)
        ? prev.document_ids.filter(id => id !== docId)
        : [...prev.document_ids, docId]
    }));
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card p-4">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">Agents</h1>
          </div>
          <Button onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4 mr-2" />
            New Agent
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {showForm ? (
          <Card className="max-w-2xl mx-auto">
            <CardHeader>
              <CardTitle>{editingId ? "Edit Agent" : "Create New Agent"}</CardTitle>
              <CardDescription>
                Configure your AI agent's behavior and capabilities
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Research Assistant"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Brief description of the agent's purpose"
                    rows={2}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="system_prompt">System Prompt</Label>
                  <Textarea
                    id="system_prompt"
                    value={formData.system_prompt}
                    onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                    placeholder="You are a helpful assistant that..."
                    rows={6}
                    required
                  />
                </div>

                <div className="flex items-center space-x-2">
                  <Switch
                    id="rag_enabled"
                    checked={formData.rag_enabled}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, rag_enabled: checked })
                    }
                  />
                  <Label htmlFor="rag_enabled">Enable RAG (Document Access)</Label>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Wissensbasis-Dokumente</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowDocumentPicker(!showDocumentPicker)}
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      {formData.document_ids.length > 0 
                        ? `${formData.document_ids.length} ausgewählt` 
                        : "Dokumente auswählen"}
                    </Button>
                  </div>
                  
                  {showDocumentPicker && (
                    <Card className="p-4 max-h-60 overflow-y-auto">
                      {documents.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          Keine Dokumente verfügbar. Laden Sie zuerst Dokumente hoch.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {documents.map((doc) => (
                            <div
                              key={doc.id}
                              className="flex items-center space-x-2 p-2 hover:bg-accent rounded cursor-pointer"
                              onClick={() => toggleDocument(doc.id)}
                            >
                              <input
                                type="checkbox"
                                checked={formData.document_ids.includes(doc.id)}
                                onChange={() => toggleDocument(doc.id)}
                                className="h-4 w-4"
                              />
                              <span className="text-sm flex-1">{doc.title}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  )}

                  {formData.document_ids.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {formData.document_ids.map((docId) => {
                        const doc = documents.find(d => d.id === docId);
                        return doc ? (
                          <div
                            key={docId}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-primary/10 text-primary rounded text-sm"
                          >
                            <span>{doc.title}</span>
                            <button
                              type="button"
                              onClick={() => toggleDocument(docId)}
                              className="hover:bg-primary/20 rounded-full p-0.5"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ) : null;
                      })}
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button type="submit" className="flex-1">
                    {editingId ? "Update Agent" : "Create Agent"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowForm(false);
                      setEditingId(null);
                      setFormData({
                        name: "",
                        description: "",
                        system_prompt: "",
                        rag_enabled: true,
                        document_ids: [],
                      });
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {loading ? (
              <p>Loading agents...</p>
            ) : agents.length === 0 ? (
              <Card className="col-span-full">
                <CardContent className="p-8 text-center">
                  <p className="text-muted-foreground">No agents yet. Create your first agent!</p>
                </CardContent>
              </Card>
            ) : (
              agents.map((agent) => (
                <Card key={agent.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span>{agent.name}</span>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(agent)}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(agent.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardTitle>
                    {agent.description && (
                      <CardDescription>{agent.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">RAG Enabled:</span>
                        <span>{agent.rag_enabled ? "Yes" : "No"}</span>
                      </div>
                      {agent.document_ids && agent.document_ids.length > 0 && (
                        <div className="pt-2 border-t">
                          <p className="text-muted-foreground mb-1">
                            Wissensbasis: {agent.document_ids.length} Dokument(e)
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {agent.document_ids.slice(0, 3).map((docId) => {
                              const doc = documents.find(d => d.id === docId);
                              return doc ? (
                                <span key={docId} className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">
                                  {doc.title}
                                </span>
                              ) : null;
                            })}
                            {agent.document_ids.length > 3 && (
                              <span className="text-xs px-2 py-0.5 bg-muted rounded">
                                +{agent.document_ids.length - 3} mehr
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="pt-2 border-t">
                        <p className="text-muted-foreground mb-1">System Prompt:</p>
                        <p className="text-xs line-clamp-3">{agent.system_prompt}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default Agents;
