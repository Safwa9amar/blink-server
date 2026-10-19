// Pure text helpers for the support-bot RAG pipeline (no DB / network, unit-tested):
// the article chunker, the keyword tokenizer and the retrieval-query builder.

import * as cheerio from "cheerio";

// The app user_role enum is lowercase ("rider"); support `target_roles` use the
// dashboard's capitalized labels ("Rider").
export const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  rider: "Rider",
  merchant: "Merchant",
  agent: "Agent",
};

export interface KbChunk {
  title: string;
  content: string;
}

export const MAX_CHUNK_CHARS = 1200;
export const MAX_FAQ_CHARS = 2000;

const BLOCK_SELECTOR = "h1,h2,h3,h4,p,li,blockquote,pre,tr";

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Split text longer than `max` on sentence boundaries (hard-split as a last resort). */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.split(/(?<=[.!?؟。])\s+/);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + s.length > max) flush();
    cur = cur ? cur + " " + s : s;
  }
  flush();
  return out;
}

/** Pack paragraphs into chunks of at most `max` chars (newline-joined). */
function pack(paras: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of paras.flatMap((x) => splitLong(x, max))) {
    if (cur && cur.length + 1 + p.length > max) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n" + p : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** Plain text of an HTML body (whitespace collapsed). */
export function htmlToText(html: string): string {
  // Pad block boundaries so adjacent blocks don't glue together ("a.</p><p>b").
  const padded = String(html ?? "").replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th)\b[^>]*>/gi, "$& ");
  return clean(cheerio.load(padded).root().text());
}

/**
 * Chunk one article/FAQ for retrieval. FAQs → a single chunk (question + answer)
 * unless the answer is very long. Articles → sections split at headings, with
 * paragraphs packed up to ~1200 chars; chunk title is "Article › Section".
 */
export function chunkArticle(input: {
  type: string;
  title: string;
  html: string;
}): KbChunk[] {
  const title = clean(input.title ?? "");
  const html = String(input.html ?? "");
  if (!title && !html.trim()) return [];

  if (input.type === "faq") {
    const answer = htmlToText(html);
    if (!answer) return [];
    if (answer.length <= MAX_FAQ_CHARS) return [{ title, content: answer }];
    // fall through: chunk an over-long answer like an article
  }

  const $ = cheerio.load(html);
  const sections: { heading: string; paras: string[] }[] = [{ heading: "", paras: [] }];
  let blocks = 0;
  $(BLOCK_SELECTOR).each((_, el) => {
    const $el = $(el);
    // Leaf blocks only — a <li> holding <p>, or a <tr> holding block cells, is
    // represented by its inner blocks (avoids duplicated text).
    if ($el.find(BLOCK_SELECTOR).length > 0) return;
    const tag = (el as any).tagName?.toLowerCase() as string;
    let text: string;
    if (tag === "tr") {
      text = $el
        .children("td,th")
        .map((__, c) => clean($(c).text()))
        .get()
        .filter(Boolean)
        .join(" | ");
    } else {
      text = clean($el.text());
    }
    if (!text) return;
    blocks++;
    if (/^h[1-4]$/.test(tag)) sections.push({ heading: text, paras: [] });
    else sections[sections.length - 1].paras.push(text);
  });

  if (blocks === 0) {
    // No block markup (plain text body) — treat the whole text as one section.
    const text = clean($.root().text());
    if (text) sections[0].paras.push(text);
  }

  const out: KbChunk[] = [];
  for (const sec of sections) {
    if (!sec.paras.length) continue;
    const chunkTitle = sec.heading && sec.heading !== title ? `${title} › ${sec.heading}` : title;
    for (const content of pack(sec.paras, MAX_CHUNK_CHARS)) {
      out.push({ title: chunkTitle, content });
    }
  }
  return out;
}

// ─── Keyword query ───────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    // English
    "the a an and or of to in on at for with is are was were be been it this that these those i me my we you your he she they them do does did can could would should how what when where why which who whom if as by from not no yes there here have has had will just so but about into than then also please hi hello " +
    // French
    "le la les un une des du de et ou à au aux en dans sur pour avec est sont été être ce cet cette ces je me mon ma mes nous vous votre vos il elle ils elles on que qui quoi quand où comment pourquoi par pas ne se sa son ses y a ai as ont j l d s t qu bonjour salut merci " +
    // Arabic
    "في من على الى إلى عن مع هذا هذه ذلك تلك هو هي هم انا أنا انت أنت نحن ما ماذا كيف متى اين أين لماذا هل لا نعم و او أو ثم قد كان كانت يكون التي الذي الذين كل بعد قبل عند لدي لدى مرحبا"
  ).split(/\s+/)
);

/** Sanitized, deduped search tokens (letters/digits only — safe for to_tsquery). */
export function tokenizeQuery(q: string): string[] {
  const toks = (String(q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t)
  );
  return [...new Set(toks)].slice(0, 24);
}

/** `a | b | c` for to_tsquery('simple', …), or '' when nothing useful remains. */
export function buildKeywordQuery(q: string): string {
  return tokenizeQuery(q).join(" | ");
}

// ─── Retrieval query ─────────────────────────────────────────────────────────

function wordCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * Text to retrieve against: the last user message; if it is very short (a
 * follow-up like "and for riders?") the previous user message is prepended.
 */
export function buildRetrievalQuery(
  history: { role: string; content: string }[]
): string {
  const users = history.filter((m) => m.role === "user" && m.content?.trim());
  if (!users.length) return "";
  const last = users[users.length - 1].content.trim();
  let q = last;
  if (wordCount(last) < 6 && users.length > 1) {
    q = users[users.length - 2].content.trim() + "\n" + last;
  }
  return q.slice(0, 1000);
}
