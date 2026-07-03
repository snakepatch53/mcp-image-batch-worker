import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";

const LMSTUDIO_API_BASE = process.env.LMSTUDIO_API_BASE || "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = process.env.LMSTUDIO_MODEL || "gemma-4-12b-it-qat";
const LMSTUDIO_TEMPERATURE = Number(process.env.LMSTUDIO_TEMPERATURE || "0");
const LMSTUDIO_MAX_TOKENS = Number(process.env.LMSTUDIO_MAX_TOKENS || "300");

const server = new McpServer({
  name: "mcp-image-batch-worker",
  version: "1.0.0",
});

const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
let isProcessing = false;

function getMimeType(extension: string): string {
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function toLmStudioImagePayload(imageBuffer: Buffer, extension: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // LM Studio puede rechazar WEBP en chat/completions; lo convertimos a PNG para compatibilidad.
  if (extension === ".webp") {
    const converted = await sharp(imageBuffer).png().toBuffer();
    return { buffer: converted, mimeType: "image/png" };
  }

  return { buffer: imageBuffer, mimeType: getMimeType(extension) };
}

function extractCompletionText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item: unknown) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          const maybeText = (item as { text?: unknown }).text;
          return typeof maybeText === "string" ? maybeText : "";
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

server.registerTool(
  "process_image_batch",
  {
    description: "Procesa exactamente una imagen por invocación y devuelve el análisis directo. Si el servidor está ocupado, responde error inmediato para que el cliente reintente (sin cola interna).",
    inputSchema: {
      imagePath: z.string().describe("Ruta absoluta de Linux a una imagen individual (.png, .jpg, .jpeg, .webp)."),
      instruction: z.string().describe("Qué quieres que haga el modelo de visión con cada imagen.")
    }
  },
  async ({ imagePath, instruction }) => {
    if (isProcessing) {
      return {
        content: [{ type: "text", text: "Servidor ocupado procesando otra imagen. Reintenta en unos segundos." }],
        isError: true
      };
    }

    isProcessing = true;

    try {
      if (!fs.existsSync(imagePath)) {
        return { content: [{ type: "text", text: `Error: No existe la imagen: ${imagePath}` }], isError: true };
      }

      if (!fs.statSync(imagePath).isFile()) {
        return { content: [{ type: "text", text: `Error: La ruta no es un archivo: ${imagePath}` }], isError: true };
      }

      const ext = path.extname(imagePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return {
          content: [{ type: "text", text: `Error: Extensión no soportada (${ext}). Usa: ${SUPPORTED_EXTENSIONS.join(", ")}` }],
          isError: true
        };
      }

      // Enviar log inicial de streaming a OpenCode
      await server.sendLoggingMessage({
        level: "info",
        logger: "batch-worker",
        data: `🚀 Iniciando procesamiento de una imagen con ${DEFAULT_MODEL}...`
      });

      const fileName = path.basename(imagePath);
      await server.sendLoggingMessage({
        level: "info",
        logger: "batch-worker",
        data: `⏳ Procesando: ${fileName}...`
      });

      const imageBuffer = fs.readFileSync(imagePath);
      const lmStudioImage = await toLmStudioImagePayload(imageBuffer, ext);
      const base64Image = lmStudioImage.buffer.toString("base64");
      const mimeType = lmStudioImage.mimeType;
      const constrainedInstruction = `${instruction}\n\nReglas de salida:\n- Si no hay evidencia suficiente para identificar una persona, di claramente: \"No puedo identificar con certeza\".\n- No inventes nombres ni datos no visibles.\n- Prioriza descripción objetiva de lo que realmente se ve en la imagen.`;

      const response = await axios.post(`${LMSTUDIO_API_BASE}/chat/completions`, {
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: constrainedInstruction },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: LMSTUDIO_TEMPERATURE,
        max_tokens: LMSTUDIO_MAX_TOKENS,
        stream: false
      });

      const rawContent = response.data?.choices?.[0]?.message?.content;
      const analysisResult = extractCompletionText(rawContent).trim();
      if (!analysisResult) {
        throw new Error("LM Studio devolvió una respuesta vacía.");
      }

      const preview = analysisResult.substring(0, 60).replace(/\n/g, " ");
      await server.sendLoggingMessage({
        level: "info",
        logger: "batch-worker",
        data: `✅ Completado: ${fileName} -> "${preview}..."`
      });

      await server.sendLoggingMessage({
        level: "info",
        logger: "batch-worker",
        data: "🏁 Proceso terminado."
      });

      return {
        content: [
          {
            type: "text",
            text: `¡Imagen procesada con éxito!\n\nAnalisis:\n${analysisResult}`
          }
        ]
      };

    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const details = error.response?.data;
        const detailText = typeof details === "string" ? details : JSON.stringify(details);

        return {
          content: [{ type: "text", text: `Fallo LM Studio (${status ?? "sin status"}): ${detailText || error.message}` }],
          isError: true
        };
      }

      const message = error instanceof Error ? error.message : "Error desconocido";
      return {
        content: [{ type: "text", text: `Fallo crítico en el stream MCP: ${message}` }],
        isError: true
      };
    } finally {
      isProcessing = false;
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Error desconocido";
  console.error(`Error: ${message}`);
  process.exit(1);
});