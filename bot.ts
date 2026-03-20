#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 2.0 - Webhook mode for Amvera
 */

import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

// ============== CONFIGURATION ==============
const BOT_CONFIG = {
  token: process.env.MAX_BOT_TOKEN || '',
  adminId: parseInt(process.env.MAX_ADMIN_ID || '0'),
  port: parseInt(process.env.PORT || '8080'),
  webhookPath: '/webhook',
  domain: 'feldsher-max-bot-nnp.amvera.io',
};

// ============== LOGGING ==============
const LOG_DIR = '/app/data/logs';
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = join(LOG_DIR, 'bot.log');

function log(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  try { appendFileSync(LOG_FILE, logLine); } catch (e) {}
  console.log(`[${level}] ${message}`, data || '');
}

// ============== VALIDATION ==============
const MAX_INPUT_LENGTH = 500;
const MAX_QUESTION_LENGTH = 1000;

function sanitizeInput(text: string, maxLength = MAX_INPUT_LENGTH): string {
  if (!text) return '';
  return text.trim().substring(0, maxLength).replace(/<script|javascript:|on\w+=/gi, '');
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function validatePhone(phone: string): boolean {
  return /^[\+]?[0-9][0-9\-\s]{9,15}$/.test(phone.replace(/\s/g, ''));
}

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('8') && d.length === 11) return '+7' + d.slice(1);
  if (d.startsWith('7') && d.length === 11) return '+' + d;
  if (d.length === 10) return '+7' + d;
  return phone;
}

// ============== DATABASE ==============
if (!existsSync('/app/data')) mkdirSync('/app/data', { recursive: true });
const prisma = new PrismaClient({ log: ['error'] });

// ============== MAX API ==============
const MAX_API = 'https://api.max.ru';

async function maxApi(method: string, path: string, body?: any) {
  const url = `${MAX_API}${path}?access_token=${BOT_CONFIG.token}`;
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`MAX API error: ${res.status}`);
  return data;
}

async function sendMessage(userId: number, text: string) {
  try {
    await maxApi('POST', '/messages', { user_id: userId, body: { text } });
  } catch (e) {
    log('ERROR', `Failed to send to ${userId}`, e);
  }
}

// ============== WEBHOOK REGISTRATION ==============
async function registerWebhook() {
  const url = `https://${BOT_CONFIG.domain}${BOT_CONFIG.webhookPath}`;
  log('INFO', `Registering webhook: ${url}`);
  
  try {
    const subs = await maxApi('GET', '/subscriptions');
    if (subs.subscriptions?.some((s: any) => s.url === url)) {
      log('INFO', 'Webhook already registered');
      return true;
    }
    
    await maxApi('POST', '/subscriptions', {
      url,
      update_types: ['message_created', 'message_callback', 'bot_started'],
    });
    log('INFO', 'Webhook registered');
    return true;
  } catch (e) {
    log('ERROR', 'Webhook registration failed', e);
    return false;
  }
}

// ============== DATABASE FUNCTIONS ==============
async function getOrCreateUser(maxId: number, userData: any) {
  const existing = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (existing) return existing;
  return prisma.maxUser.create({
    data: {
      maxId: maxId.toString(),
      username: sanitizeInput(userData.username || '', 100),
      firstName: sanitizeInput(userData.firstName || '', 100),
      lastName: sanitizeInput(userData.lastName || '', 100),
    },
  });
}

async function hasUserConsent(maxId: number) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() }, select: { hasConsent: true } });
  return user?.hasConsent ?? false;
}

async function setUserConsent(maxId: number, consent: boolean) {
  return prisma.maxUser.update({ where: { maxId: maxId.toString() }, data: { hasConsent: consent } });
}

async function getUserState(maxId: number) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() }, include: { state: true } });
  if (!user?.state) return null;
  return { flowType: user.state.flowType, currentStep: user.state.currentStep, data: JSON.parse(user.state.data || '{}') };
}

async function setUserState(maxId: number, flowType: string, currentStep: string, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) return null;
  return prisma.maxUserState.upsert({
    where: { maxUserId: user.id },
    create: { maxUserId: user.id, flowType, currentStep, data: JSON.stringify(data) },
    update: { flowType, currentStep, data: JSON.stringify(data) },
  });
}

async function clearUserState(maxId: number) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (user) await prisma.maxUserState.deleteMany({ where: { maxUserId: user.id } });
}

async function saveWaitlistEntry(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxWaitlistEntry.create({
    data: { maxUserId: user.id, name: sanitizeInput(data.name, 100), phone: sanitizeInput(data.phone, 20), district: sanitizeInput(data.district, 50) },
  });
}

async function saveFeldsherApplication(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxFeldsherApplication.create({
    data: { maxUserId: user.id, name: sanitizeInput(data.name, 100), phone: sanitizeInput(data.phone, 20), experience: sanitizeInput(data.experience, 10), scheduleType: sanitizeInput(data.scheduleType, 50), resumeLink: sanitizeInput(data.resumeLink || '', 500) },
  });
}

async function saveQuestion(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxQuestion.create({
    data: { maxUserId: user.id, name: sanitizeInput(data.name, 100), phone: sanitizeInput(data.phone, 20), question: sanitizeInput(data.question, MAX_QUESTION_LENGTH) },
  });
}

async function sendNotification(type: string, data: any) {
  if (!BOT_CONFIG.adminId) return;
  let msg = '';
  if (type === 'waitlist') msg = `📋 Новая заявка:\n👤 ${data.name}\n📞 ${data.phone}\n📍 ${data.district}`;
  else if (type === 'feldsher') msg = `👨‍⚕️ Анкета фельдшера:\n👤 ${data.name}\n📞 ${data.phone}\n⏳ ${data.experience}\n📅 ${data.scheduleType}`;
  else if (type === 'question') msg = `❓ Вопрос:\n👤 ${data.name}\n📞 ${data.phone}\n💬 ${data.question}`;
  if (msg) await sendMessage(BOT_CONFIG.adminId, msg);
}

// ============== MESSAGES ==============
const CONSENT_MSG = `🔐 Подтвердите согласие с Политикой конфиденциальности:
📄 https://t.me/FeldsherRyadom/10
📝 https://t.me/FeldsherRyadom/5

Напишите "согласен" или "согласна" для продолжения.`;

const WELCOME_MSG = `👋 Здравствуйте! Я бот проекта «Фельдшеръ.Рядом».

Я помогу:
📋 /waitlist - записаться в лист ожидания
❓ /question - задать вопрос
👨‍⚕️ /feldsher - оставить резюме
❤️ /podderzhka - поддержать проект
📄 /doveren - текст доверенности`;

const DOVEREN_MSG = `📄 ДОВЕРЕННОСТЬ

Я, (ФИО доверителя), паспортные данные,
доверяю (ФИО доверенного лица), паспортные данные,
сопровождать моего ребёнка (ФИО, дата рождения)
в медицинский кабинет «Фельдшеръ.Рядом»

Предоставляю право подписывать медицинские документы.

Доверенность действительна по (ДАТА)
ПОДПИСЬ, РАСШИФРОВКА`;

const PODDERZHKA_MSG = `Спасибо за желание помочь! ❤️

Перевод: https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

Анонимно: 📞 +7 (965) 843-78-18`;

// ============== HANDLERS ==============
async function handleUpdate(update: any) {
  log('INFO', 'Update received', update);
  
  const type = update.update_type;
  
  if (type === 'bot_started') {
    const userId = update.user?.user_id;
    if (!userId) return;
    log('INFO', `Bot started by ${userId}`);
    await getOrCreateUser(userId, { username: update.user?.username, firstName: update.user?.first_name });
    if (!(await hasUserConsent(userId))) {
      await sendMessage(userId, CONSENT_MSG);
      return;
    }
    await clearUserState(userId);
    await sendMessage(userId, WELCOME_MSG);
    return;
  }
  
  if (type === 'message_created') {
    const userId = update.message?.sender?.user_id;
    const text = update.message?.body?.text;
    if (!userId || !text) return;
    
    log('INFO', `Message from ${userId}: ${text}`);
    
    // Consent check
    if (['согласен', 'согласна', 'да'].some(k => text.toLowerCase().includes(k))) {
      if (!(await hasUserConsent(userId))) {
        await getOrCreateUser(userId, {});
        await setUserConsent(userId, true);
        await sendMessage(userId, '✅ Спасибо! Напишите /start');
        return;
      }
    }
    
    // Commands
    if (text.startsWith('/')) {
      const cmd = text.split(' ')[0].toLowerCase();
      await getOrCreateUser(userId, {});
      
      if (cmd === '/start') {
        if (!(await hasUserConsent(userId))) { await sendMessage(userId, CONSENT_MSG); return; }
        await clearUserState(userId);
        await sendMessage(userId, WELCOME_MSG);
      } else if (cmd === '/waitlist') {
        if (!(await hasUserConsent(userId))) { await sendMessage(userId, CONSENT_MSG); return; }
        await setUserState(userId, 'waitlist', 'name', {});
        await sendMessage(userId, 'Напишите ваше имя:');
      } else if (cmd === '/question') {
        if (!(await hasUserConsent(userId))) { await sendMessage(userId, CONSENT_MSG); return; }
        await setUserState(userId, 'question', 'name', {});
        await sendMessage(userId, 'Напишите ваше имя:');
      } else if (cmd === '/feldsher') {
        if (!(await hasUserConsent(userId))) { await sendMessage(userId, CONSENT_MSG); return; }
        await setUserState(userId, 'feldsher', 'name', {});
        await sendMessage(userId, 'Напишите ваше имя:');
      } else if (cmd === '/doveren') {
        await sendMessage(userId, DOVEREN_MSG);
      } else if (cmd === '/podderzhka') {
        await sendMessage(userId, PODDERZHKA_MSG);
      }
      return;
    }
    
    // Cancel
    if (text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
      await clearUserState(userId);
      await sendMessage(userId, '❌ Отменено. /start');
      return;
    }
    
    // State flows
    const state = await getUserState(userId);
    if (!state) { await sendMessage(userId, 'Напишите /start'); return; }
    
    const data = state.data;
    const sanitized = sanitizeInput(text, state.flowType === 'question' && state.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);
    
    if (state.flowType === 'waitlist') {
      if (state.currentStep === 'name') {
        data.name = sanitized;
        await setUserState(userId, 'waitlist', 'phone', data);
        await sendMessage(userId, 'Телефон (+7-9хх-ххх-хх-хх):');
      } else if (state.currentStep === 'phone') {
        if (!validatePhone(sanitized)) { await sendMessage(userId, 'Неверный формат. Введите +7-9хх-ххх-хх-хх:'); return; }
        data.phone = formatPhone(sanitized);
        await setUserState(userId, 'waitlist', 'district', data);
        await sendMessage(userId, 'Район (цифра):\n1. Индустриальный\n2. Ленинский\n3. Октябрьский\n4. Первомайский\n5. Устиновский');
      } else if (state.currentStep === 'district') {
        const map: any = { '1': 'Индустриальный', '2': 'Ленинский', '3': 'Октябрьский', '4': 'Первомайский', '5': 'Устиновский' };
        data.district = map[sanitized] || sanitized;
        try {
          await saveWaitlistEntry(userId, data);
          await sendNotification('waitlist', data);
          await clearUserState(userId);
          await sendMessage(userId, `✅ Спасибо, ${data.name}! Вы в листе ожидания.`);
        } catch (e) { await sendMessage(userId, 'Ошибка. Попробуйте позже.'); }
      }
    } else if (state.flowType === 'feldsher') {
      if (state.currentStep === 'name') {
        data.name = sanitized;
        await setUserState(userId, 'feldsher', 'phone', data);
        await sendMessage(userId, 'Телефон (+7-9хх-ххх-хх-хх):');
      } else if (state.currentStep === 'phone') {
        if (!validatePhone(sanitized)) { await sendMessage(userId, 'Неверный формат.'); return; }
        data.phone = formatPhone(sanitized);
        await setUserState(userId, 'feldsher', 'experience', data);
        await sendMessage(userId, 'Стаж работы (лет):');
      } else if (state.currentStep === 'experience') {
        data.experience = sanitized;
        await setUserState(userId, 'feldsher', 'schedule', data);
        await sendMessage(userId, 'График (1 или 2):\n1. 16 смен\n2. 12 смен');
      } else if (state.currentStep === 'schedule') {
        data.scheduleType = sanitized === '1' ? '16 смен' : '12 смен';
        await setUserState(userId, 'feldsher', 'resume', data);
        await sendMessage(userId, 'Ссылка на резюме (или "нет"):');
      } else if (state.currentStep === 'resume') {
        data.resumeLink = sanitized === 'нет' ? '' : sanitized;
        try {
          await saveFeldsherApplication(userId, data);
          await sendNotification('feldsher', data);
          await clearUserState(userId);
          await sendMessage(userId, `✅ Спасибо, ${data.name}! Анкета принята.`);
        } catch (e) { await sendMessage(userId, 'Ошибка. Попробуйте позже.'); }
      }
    } else if (state.flowType === 'question') {
      if (state.currentStep === 'name') {
        data.name = sanitized;
        await setUserState(userId, 'question', 'phone', data);
        await sendMessage(userId, 'Телефон (+7-9хх-ххх-хх-хх):');
      } else if (state.currentStep === 'phone') {
        if (!validatePhone(sanitized)) { await sendMessage(userId, 'Неверный формат.'); return; }
        data.phone = formatPhone(sanitized);
        await setUserState(userId, 'question', 'question', data);
        await sendMessage(userId, 'Ваш вопрос:');
      } else if (state.currentStep === 'question') {
        data.question = sanitized;
        try {
          await saveQuestion(userId, data);
          await sendNotification('question', data);
          await clearUserState(userId);
          await sendMessage(userId, `✅ Спасибо, ${data.name}! Вопрос принят.`);
        } catch (e) { await sendMessage(userId, 'Ошибка. Попробуйте позже.'); }
      }
    }
  }
}

// ============== HTTP SERVER ==============
Bun.serve({
  port: BOT_CONFIG.port,
  async fetch(req) {
    const url = new URL(req.url);
    
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({ status: 'ok', mode: 'webhook', time: new Date().toISOString() });
    }
    
    if (url.pathname === BOT_CONFIG.webhookPath && req.method === 'POST') {
      try {
        const update = await req.json();
        handleUpdate(update);
        return Response.json({ ok: true });
      } catch (e) {
        log('ERROR', 'Webhook error', e);
        return Response.json({ ok: false }, { status: 500 });
      }
    }
    
    return new Response('Not found', { status: 404 });
  },
});

// ============== MAIN ==============
async function main() {
  console.log('🤖 Bot starting (webhook mode)...');
  
  if (!BOT_CONFIG.token) {
    console.error('❌ MAX_BOT_TOKEN not set!');
    process.exit(1);
  }
  
  try {
    await prisma.$connect();
    console.log('✅ Database connected');
  } catch (e) {
    console.error('❌ Database failed:', e);
    process.exit(1);
  }
  
  // Set commands
  try {
    await maxApi('PATCH', '/me', {
      commands: [
        { name: 'start', description: 'Начать' },
        { name: 'waitlist', description: 'Лист ожидания' },
        { name: 'question', description: 'Задать вопрос' },
        { name: 'feldsher', description: 'Резюме фельдшера' },
        { name: 'doveren', description: 'Доверенность' },
        { name: 'podderzhka', description: 'Поддержать' },
      ],
    });
    console.log('✅ Commands set');
  } catch (e) {
    console.log('⚠️ Commands failed');
  }
  
  // Register webhook
  if (await registerWebhook()) {
    console.log('✅ Webhook registered');
  } else {
    console.log('⚠️ Webhook failed');
  }
  
  console.log(`🌐 Server on port ${BOT_CONFIG.port}`);
  console.log(`🔗 Webhook: https://${BOT_CONFIG.domain}${BOT_CONFIG.webhookPath}`);
  console.log('✅ Bot ready!');
}

main().catch(e => console.error(e));
