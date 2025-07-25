import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";
import { handleTools } from './functions.js';
import fs from "fs";
import path from "path";
import { json } from "stream/consumers";

// Load environment variables from .env file
dotenv.config();

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const { ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY } = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const calls = {};

// Check for the required ElevenLabs Agent ID
if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error(
    "Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in environment variables"
  );
  process.exit(1);
}

// Initialize Fastify server
// const fastify = Fastify();

const fastify = Fastify({
  https: {
    key: fs.readFileSync("/etc/letsencrypt/live/api.integrasistema.com/privkey.pem"),
    cert: fs.readFileSync("/etc/letsencrypt/live/api.integrasistema.com/fullchain.pem")
  }
});

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5053;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  console.log("[Server] Incoming call from Twilio:", request.body);
  const { CallSid, CallerName } = request.body;
  calls[CallSid] = CallerName || "Unknown Caller";

  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

async function hangupTwilioCall(callSid) {
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
    console.log(`[Twilio] Ligação encerrada via API: ${callSid}`);
  } catch (error) {
    console.error('[Twilio] Erro ao encerrar ligação via API:', error);
  }
}

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let caller_name = null; // Variable to store caller name
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on("error", console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI");
        });

        elevenLabsWs.on("message", data => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case "conversation_initiation_metadata":
                console.log("[ElevenLabs] Received initiation metadata");
                break;

              case "audio":
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log(
                    "[ElevenLabs] Received audio but no StreamSid yet"
                  );
                }
                break;

              case "interruption":
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: "clear",
                      streamSid,
                    })
                  );
                }
                break;

              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case "agent_response":
                console.log(
                  `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                );
                break;

              case "user_transcript":
                console.log(
                  `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                break;
              
              case "client_tool_call":
                  (async () => {
                    
                    const tool_Call = message.client_tool_call;
                    const { tool_name, tool_call_id, parameters } = tool_Call;
                    console.log(
                      `[ElevenLabs] Client tool call: ${tool_name}, ID: ${tool_call_id}`
                    );
                    console.log(
                      `[ElevenLabs] Parameters: ${JSON.stringify(parameters)}`
                    );
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "client_tool_result",
                        tool_call_id: tool_call_id,
                        result: "EXECUTED",
                        is_error: false
                      })
                    );
                    const tool_response = await handleTools(
                      elevenLabsWs,
                      ws,
                      tool_name,
                      parameters,
                      tool_call_id,
                      caller_name
                    );
                    console.log(
                      `[ElevenLabs] Tool response: ${tool_response}`
                    );
                      
                  })();
                break;

              default:
                console.log(
                  `[ElevenLabs] Unhandled message type: ${message.type}`
                );
            }
          } catch (error) {
            console.error("[ElevenLabs] Error processing message:", error);
          }
        });

        elevenLabsWs.on("error", error => {
          console.error("[ElevenLabs] WebSocket error:", error);
        });

        elevenLabsWs.on("close", async () => {
          console.log("[ElevenLabs] Disconnected");
          if (callSid) {
            await hangupTwilioCall(callSid);
          } else {
            console.warn("[Twilio] callSid não disponível para encerrar ligação.");
          }
        });
      } catch (error) {
        console.error("[ElevenLabs] Setup error:", error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            caller_name = calls[callSid] || "Unknown Caller";
            console.log(
              `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}, CallerName: ${caller_name}`
            );
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(
                  msg.media.payload,
                  "base64"
                ).toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle WebSocket closure
    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, err => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});