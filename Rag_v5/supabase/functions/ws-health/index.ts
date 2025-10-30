import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const { headers } = req;
  const upgradeHeader = headers.get("upgrade") || "";

  // If not a websocket upgrade, return simple JSON health
  if (upgradeHeader.toLowerCase() !== "websocket") {
    return new Response(JSON.stringify({ status: "ok", time: Date.now() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // WS echo server for health checking
  const { socket, response } = Deno.upgradeWebSocket(req);

  let pingInterval: number | undefined;

  socket.onopen = () => {
    console.log("ws-health: client connected");
    pingInterval = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: "server_ping", ts: Date.now() }));
      } catch (_) {}
    }, 20000) as unknown as number;
  };

  socket.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data?.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch (_) {}
      } else {
        // Echo back for visibility
        socket.send(JSON.stringify({ type: "echo", data }));
      }
    } catch {
      // Non-JSON, echo text
      socket.send(ev.data);
    }
  };

  socket.onclose = (ev) => {
    console.log("ws-health: closed", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
    try {
      if (pingInterval) clearInterval(pingInterval);
    } catch (_) {}
  };

  socket.onerror = (err) => {
    console.error("ws-health: error", err);
  };

  return response;
});
