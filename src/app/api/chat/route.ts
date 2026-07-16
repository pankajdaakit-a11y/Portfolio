import { NextRequest, NextResponse } from "next/server";
import { DATA } from "@/data/resume";
import { getSupabaseServerClient } from "@/lib/supabase-server";

type ChatMessage = {
  text: string;
  sender?: "user" | "ai";
};

const MAX_MESSAGES = 12;

function localAnswer(question: string) {
  const lower = question.toLowerCase();

  if (lower.includes("hire")) {
    return `You should hire ${DATA.name} for full-stack delivery, polished modern UI, and a practical, ownership-driven approach to building products.`;
  }

  if (lower.includes("contact") || lower.includes("email") || lower.includes("reach")) {
    return `You can reach ${DATA.name} at **${DATA.contact.email}** or through [LinkedIn](${DATA.contact.social.LinkedIn?.url}).`;
  }

  if (lower.includes("project")) {
    const project = DATA.projects?.[0];
    if (project) return `A featured project is **${project.title}** — ${project.description}`;
  }

  return `I'm ${DATA.name}'s portfolio assistant. Ask me about experience, skills, projects, or how to get in touch.`;
}

async function logChat(payload: {
  conversationId?: string;
  question: string;
  answer: string;
  modelId: string;
  ok: boolean;
  error?: string;
}) {
  try {
    const supabase = getSupabaseServerClient();
    if (!supabase) return;

    const { error } = await supabase.from("chat_logs").insert({
      conversation_id: payload.conversationId ?? null,
      model_id: payload.modelId,
      question: payload.question,
      answer: payload.answer,
      ok: payload.ok,
      error: payload.error ?? null,
    });

    if (error) console.error("Unable to log chat:", error.message);
  } catch (error) {
    // Analytics must never prevent the chat answer from reaching the visitor.
    console.error("Unable to log chat:", error);
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    messages?: ChatMessage[];
    modelId?: string;
    conversationId?: string;
  } | null;
  const messages = body?.messages?.filter((message) => message?.text?.trim()).slice(-MAX_MESSAGES) ?? [];
  const question = messages.at(-1)?.text?.trim() ?? "";
  const modelId = body?.modelId ?? "v2";
  const conversationId = body?.conversationId;

  if (!question) {
    return NextResponse.json({ text: localAnswer("") });
  }

  if (modelId === "local") {
    const text = localAnswer(question);
    await logChat({ conversationId, question, answer: text, modelId, ok: true });
    return NextResponse.json({ text });
  }

  const systemPrompt = `You are ${DATA.name}'s portfolio AI assistant. Answer questions about the portfolio accurately using this background data:\n${JSON.stringify(DATA)}\n\nBe concise, friendly, and professional. If information is not in the portfolio, say so rather than inventing it.`;
  const chatMessages = messages.map((message) => ({
    role: message.sender === "ai" ? "assistant" : "user",
    content: message.text,
  }));

  let groqError: string | undefined;
  const groqKey = process.env.GROQ_API_KEY;

  if (groqKey) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: systemPrompt }, ...chatMessages],
        }),
      });
      const data = await response.json().catch(() => ({}));
      const text = data.choices?.[0]?.message?.content;

      if (response.ok && text) {
        await logChat({ conversationId, question, answer: text, modelId: "groq", ok: true });
        return NextResponse.json({ text });
      }
      groqError = data?.error?.message ?? `Groq returned ${response.status}`;
    } catch (error) {
      groqError = error instanceof Error ? error.message : "Groq request failed";
    }
  } else {
    groqError = "Missing GROQ_API_KEY";
  }

  console.error("Groq unavailable; trying Gemini:", groqError);
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{ text: `${systemPrompt}\n\nConversation:\n${chatMessages.map((message) => `${message.role}: ${message.content}`).join("\n")}` }],
            }],
          }),
        },
      );
      const data = await response.json().catch(() => ({}));
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

      if (response.ok && text) {
        await logChat({ conversationId, question, answer: text, modelId: "gemini", ok: true });
        return NextResponse.json({ text });
      }
      throw new Error(data?.error?.message ?? `Gemini returned ${response.status}`);
    } catch (error) {
      console.error("Gemini fallback failed:", error);
      const text = localAnswer(question);
      await logChat({
        conversationId,
        question,
        answer: text,
        modelId: "local",
        ok: false,
        error: `${groqError}; ${error instanceof Error ? error.message : "Gemini request failed"}`,
      });
      return NextResponse.json({ text });
    }
  }

  const text = localAnswer(question);
  await logChat({ conversationId, question, answer: text, modelId: "local", ok: false, error: `${groqError}; Missing GEMINI_API_KEY` });
  return NextResponse.json({ text });
}
