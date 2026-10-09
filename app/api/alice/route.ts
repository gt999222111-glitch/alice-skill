import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@upstash/redis';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CSE_API_KEY = process.env.CSE_API_KEY;
const CSE_CX = process.env.CSE_CX;

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

// Клиент Redis (Upstash)
const redis = createClient({
  username: process.env.UPSTASH_REDIS_USERNAME,
  password: process.env.UPSTASH_REDIS_PASSWORD,
  url: process.env.UPSTASH_REDIS_URL,
});

async function getSearchContext(query: string) {
  if (!CSE_API_KEY || !CSE_CX) return '';
  try {
    const res = await fetch(
      `https://www.googleapis.com/customsearch/v1?key=${CSE_API_KEY}&cx=${CSE_CX}&q=${encodeURIComponent(query)}&num=3`
    );
    const data = await res.json();
    if (data.items) {
      return data.items.map((item: any) => item.snippet).join('; ');
    }
  } catch (e) {
    console.error('Search error', e);
  }
  return '';
}

async function summarizeHistory(history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) {
  if (history.length <= 5) return '';

  const lastMessages = history.slice(-5).map(m =>
    `${m.role === 'user' ? 'Ты' : 'Алиса'}: ${m.content}`
  ).join('\n');

  try {
    const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Сделай краткую выжимку этого диалога (2–3 предложения), чтобы сохранить суть для продолжения разговора. Не добавляй заголовков и лишних слов:\n\n${lastMessages}`
          }]
        }]
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    return '';
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { request, session } = body;

    if (!request || !request.original_utterance) {
      return NextResponse.json({
        response: { text: 'Я не расслышал, повторите, пожалуйста.', tts: '' },
        version: '1.0'
      });
    }

    const userQuery = request.original_utterance;
    const sessionId = session.session_id;

    // Получаем историю из Redis
    let historyRaw = await redis.get<any[]>(sessionId);
    let history = historyRaw || [];

    history.push({ role: 'user', content: userQuery });

    // Если сообщений больше 10 — делаем саммари, чтобы не упираться в лимиты токенов
    if (history.length > 10) {
      const summary = await summarizeHistory(history);
      history = [
        { role: 'system', content: summary },
        { role: 'user', content: userQuery }
      ];
    }

    // Поиск только если вопрос похож на поисковый
    let searchContext = '';
    if (userQuery.length > 20 || /найди|сколько|когда|где|новости|цена/i.test(userQuery)) {
      searchContext = await getSearchContext(userQuery);
    }

    const historyText = history.map(m => {
      if (m.role === 'system') return `Контекст разговора: ${m.content}`;
      return `${m.role === 'user' ? 'Ты' : 'Алиса'}: ${m.content}`;
    }).join('\n');

    const prompt = `
Ты голосовой ассистент для Яндекс Алисы (колонка Мини 2).
Отвечай КРАТКО: 1–2 предложения, максимум 120 символов.
Не используй списки, маркеры, Markdown, ссылки, цифры без контекста. Тон живой, разговорный.

${historyText}

Контекст из поиска (если есть):
${searchContext || 'Нет контекста поиска'}

Вопрос пользователя: ${userQuery}

Ответ (только чистый текст, без кавычек и маркеров):
    `.trim();

    const fetchPromise = fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Timeout')), 3000);
      fetchPromise
        .then(res => { clearTimeout(timeoutId); resolve(res); })
        .catch(err => { clearTimeout(timeoutId); reject(err); });
    });

    const res = await responsePromise;
    const data = await res.json();

    let aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Извините, я не смог обработать запрос.';

    if (aiText.length > 150) {
      aiText = aiText.substring(0, 147) + '...';
    }

    history.push({ role: 'assistant', content: aiText });
    await redis.set(sessionId, history, { EX: 3600 }); // TTL 1 час

    return NextResponse.json({
      response: {
        text: aiText,
        tts: aiText,
        end_session: false
      },
      version: '1.0',
      session: {
        session_id: session.session_id,
        message_id: session.message_id,
        user_id: session.user_id
      }
    });
  } catch (error) {
    if ((error as Error).message === 'Timeout') {
      return NextResponse.json({
        response: { text: 'Сейчас много думаю, спросите проще или позже.', tts: '' },
        version: '1.0'
      });
    }
    console.error(error);
    return NextResponse.json({
      response: { text: 'Произошла ошибка соединения. Попробуйте позже.', tts: '' },
      version: '1.0'
    });
  }
}
