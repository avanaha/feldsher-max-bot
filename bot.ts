#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 11.6
 * 
 * v11.6: Новая база данных при каждом запуске (решение проблемы с форматом дат)
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ============== CONFIG ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '162749713');
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || '-72328888338961';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'feldsher-encryption-key-2024';

// ============== DATABASE PATH - ВСЕГДА НОВЫЙ ФАЙЛ ==============
const dataDir = '/app/data';
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Используем фиксированное имя базы - Prisma создаст её правильно
const dbPath = join(dataDir, 'bot.db');

// Устанавливаем DATABASE_URL ДО импорта PrismaClient
process.env.DATABASE_URL = `file:${dbPath}`;

// ============== LOGGING ==============
const LOG_DIR = join(dataDir, 'logs');
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}
const LOG_FILE = join(LOG_DIR, 'bot.log');

function log(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  try { appendFileSync(LOG_FILE, logLine); } catch (e) {}
  console.log(`[${level}] ${message}`, data || '');
}

// ============== ENCRYPTION ==============
const ALGORITHM = 'aes-256-cbc';
const KEY = scryptSync(ENCRYPTION_KEY, 'salt', 32);

function encrypt(text: string): string {
  if (!text) return '';
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  if (!encryptedText) return '';
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return encryptedText;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return encryptedText;
  }
}

// ============== VALIDATION ==============
function sanitize(text: string, max = 500): string {
  return text?.trim().substring(0, max).replace(/<script|javascript:/gi, '') || '';
}

function validPhone(t: string): boolean {
  const d = t.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15;
}

function fmtPhone(t: string): string {
  const d = t.replace(/\D/g, '');
  if (d.length === 10) return `+7 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,8)}-${d.slice(8)}`;
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) {
    const x = d.slice(1);
    return `+7 (${x.slice(0,3)}) ${x.slice(3,6)}-${x.slice(6,8)}-${x.slice(8)}`;
  }
  return t;
}

function validExp(t: string): boolean {
  const n = parseInt(t.replace(/\D/g, ''));
  return !isNaN(n) && n >= 0 && n <= 50;
}

// ============== PRISMA ==============
const prisma = new PrismaClient();

// Создаём таблицы через Prisma $executeRaw
async function initDB() {
  log('INFO', 'Initializing database...');
  log('INFO', `DB path: ${dbPath}`);
  
  try {
    // Создаём таблицы простым SQL с совместимым форматом дат
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxUser (
        id TEXT PRIMARY KEY,
        maxId TEXT UNIQUE NOT NULL,
        username TEXT,
        firstName TEXT,
        lastName TEXT,
        hasConsent INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updatedAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxUserState (
        id TEXT PRIMARY KEY,
        maxUserId TEXT UNIQUE NOT NULL,
        currentStep TEXT NOT NULL,
        flowType TEXT NOT NULL,
        data TEXT,
        createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updatedAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxWaitlistEntry (
        id TEXT PRIMARY KEY,
        maxUserId TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        district TEXT NOT NULL,
        createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxFeldsherApplication (
        id TEXT PRIMARY KEY,
        maxUserId TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        experience TEXT NOT NULL,
        scheduleType TEXT NOT NULL,
        resumeLink TEXT,
        createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxQuestion (
        id TEXT PRIMARY KEY,
        maxUserId TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        question TEXT NOT NULL,
        isAnswered INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE
      )
    `);
    
    log('INFO', 'Database tables created');
    return true;
  } catch (e: any) {
    log('ERROR', 'DB init failed', { msg: e.message, code: e.code });
    return false;
  }
}

// ============== DB FUNCTIONS ==============
async function getUser(maxId: number) {
  return prisma.maxUser.findUnique({ where: { maxId: String(maxId) } });
}

async function createUser(maxId: number, d: any) {
  return prisma.maxUser.create({
    data: {
      maxId: String(maxId),
      username: sanitize(d.username, 100),
      firstName: sanitize(d.firstName, 100),
      lastName: sanitize(d.lastName, 100),
    }
  });
}

async function getOrCreateUser(maxId: number, d: any) {
  const u = await getUser(maxId);
  return u || createUser(maxId, d);
}

async function hasConsent(maxId: number): Promise<boolean> {
  const u = await getUser(maxId);
  return u?.hasConsent ?? false;
}

async function setConsent(maxId: number, v: boolean) {
  return prisma.maxUser.update({ where: { maxId: String(maxId) }, data: { hasConsent: v } });
}

async function delUser(maxId: number) {
  const u = await getUser(maxId);
  if (!u) return false;
  await prisma.maxUserState.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxWaitlistEntry.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxFeldsherApplication.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxQuestion.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxUser.delete({ where: { id: u.id } });
  return true;
}

async function getState(maxId: number) {
  const u = await prisma.maxUser.findUnique({ where: { maxId: String(maxId) }, include: { state: true } });
  if (!u?.state) return null;
  return { flow: u.state.flowType, step: u.state.currentStep, data: JSON.parse(u.state.data || '{}') };
}

async function setState(maxId: number, flow: string, step: string, data: any) {
  const u = await getUser(maxId);
  if (!u) return;
  return prisma.maxUserState.upsert({
    where: { maxUserId: u.id },
    create: { maxUserId: u.id, flowType: flow, currentStep: step, data: JSON.stringify(data) },
    update: { flowType: flow, currentStep: step, data: JSON.stringify(data) }
  });
}

async function clearState(maxId: number) {
  const u = await getUser(maxId);
  if (u) await prisma.maxUserState.deleteMany({ where: { maxUserId: u.id } });
}

async function saveWaitlist(maxId: number, d: any) {
  const u = await getUser(maxId);
  if (!u) throw new Error('no user');
  return prisma.maxWaitlistEntry.create({
    data: { maxUserId: u.id, name: sanitize(d.name, 100), phone: encrypt(d.phone), district: sanitize(d.district, 50) }
  });
}

async function saveFeldsher(maxId: number, d: any) {
  const u = await getUser(maxId);
  if (!u) throw new Error('no user');
  return prisma.maxFeldsherApplication.create({
    data: {
      maxUserId: u.id, name: sanitize(d.name, 100), phone: encrypt(d.phone),
      experience: sanitize(d.exp, 10), scheduleType: sanitize(d.schedule, 50),
      resumeLink: sanitize(d.resume, 500) || null
    }
  });
}

async function saveQ(maxId: number, d: any) {
  const u = await getUser(maxId);
  if (!u) throw new Error('no user');
  return prisma.maxQuestion.create({
    data: { maxUserId: u.id, name: sanitize(d.name, 100), phone: encrypt(d.phone), question: sanitize(d.q, 1000) }
  });
}

// ============== BOT ==============
const TOKEN = process.env.MAX_BOT_TOKEN || '';
if (!TOKEN) { log('ERROR', 'No token'); process.exit(1); }

const bot = new Bot(TOKEN);

const DISTRICTS = [
  { id: '1', name: 'Индустриальный' },
  { id: '2', name: 'Ленинский' },
  { id: '3', name: 'Октябрьский' },
  { id: '4', name: 'Первомайский' },
  { id: '5', name: 'Устиновский' },
];

// ============== KEYBOARDS ==============
const KB = {
  consent: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Согласен', 'c_yes')],
    [Keyboard.button.callback('❌ Не согласен', 'c_no')],
  ]),
  main: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('📋 Лист ожидания', 'w_start')],
    [Keyboard.button.callback('💰 Оплатить предзаказ', 'order')],
    [Keyboard.button.callback('❓ Вопрос', 'q_start')],
    [Keyboard.button.callback('👨‍⚕️ Фельдшеру', 'f_start')],
    [Keyboard.button.callback('📄 Доверенность', 'doveren')],
    [Keyboard.button.callback('❤️ Поддержать', 'podderzhka')],
    [Keyboard.button.callback('🗑️ Отозвать согласие', 'revoke')],
    [Keyboard.button.callback('🔐 Правила', 'privacy')],
    [Keyboard.button.callback('📢 Каналы', 'channels')],
  ]),
  cancel: Keyboard.inlineKeyboard([[Keyboard.button.callback('❌ Отмена', 'cancel')]]),
  back: Keyboard.inlineKeyboard([[Keyboard.button.callback('🏠 Меню', 'menu')]]),
  districts: Keyboard.inlineKeyboard(DISTRICTS.map(d => [Keyboard.button.callback(d.name, `d_${d.id}`)])),
  schedule: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('16 смен', 's16')],
    [Keyboard.button.callback('12 смен', 's12')],
  ]),
  confirm: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Отправить', 'confirm')],
    [Keyboard.button.callback('❌ Отмена', 'cancel')],
  ]),
  revoke: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('❌ Отозвать', 'revoke_yes')],
    [Keyboard.button.callback('✅ Не отзывать', 'menu')],
  ]),
  podr: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('💳 Сбербанк', 'sber')],
    [Keyboard.button.callback('🌍 Planeta', 'planeta')],
    [Keyboard.button.callback('🏠 Меню', 'menu')],
  ]),
  chans: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('👥 Пациентам', 'ch_p')],
    [Keyboard.button.callback('👨‍⚕️ Фельдшерам', 'ch_f')],
    [Keyboard.button.callback('🏠 Меню', 'menu')],
  ]),
};

// ============== MESSAGES ==============
const MSG = {
  consent: `Этот бот — помощник проекта «Фельдшеръ.Рядом».

🏥 Пациентам:
📋 Лист ожидания открытия кабинета
💰 Предзаказ со скидкой
❓ Вопросы

👨‍⚕️ Фельдшерам: резюме для сотрудничества
❤️ Поддержать проект

Бот работает 24/7, админ отвечает 07:00-20:00 МСК.

✅ СОГЛАСИЕ НА ОБРАБОТКУ ПД

Даю согласие ООО «Фельдшер и Ко» (ИНН 1800048162) на обработку персональных данных (имя, телефон, район, опыт) для:
– листа ожидания
– связи
– рассмотрения кандидатуры
– ответов на вопросы

Нажимая «Согласен», принимаю условия.`,
  welcome: `👋 Здравствуйте! Бот «Фельдшеръ.Рядом».

📋 Лист ожидания
❓ Вопрос
👨‍⚕️ Резюме фельдшеру
❤️ Поддержать проект

Выберите:`,
  order: `💰 Предзаказ

Ссылка: [будет добавлена]

📧 feldland@yandex.ru`,
  doveren: `📄 Доверенность

Я, (ФИО), паспорт
доверяю (ФИО), паспорт
сопровождать ребёнка (ФИО, дата)
в кабинет «Фельдшеръ.Рядом»
для медпомощи.

Действительна по (дата)
Подпись`,
  podr: `❤️ Спасибо за желание помочь!

🌍 https://planeta.ru/campaigns/feldsherryadom
💳 https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM
📞 +7 (965) 843-78-18`,
  priv: `🔐 Правила

Политика: https://feldsher-land.ru/legal

Согласие на ПД принимается перед ботом.`,
  chans: `📢 Каналы

Пациентам:
🟪 https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8
🔵 https://vk.com/feldsherryadom

Фельдшерам:
🟪 https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8
🔵 https://vk.com/feldsherizh`,
  revoke: `Отозвать согласие?

Данные будут удалены.`,
};

// ============== HELPERS ==============
function uid(ctx: any): number | null {
  return ctx.user?.user_id || ctx.user?.id || ctx.callback?.user?.user_id || ctx.message?.sender?.user_id || ctx.update?.callback?.user?.user_id || ctx.update?.message?.sender?.user_id || null;
}

function udata(ctx: any) {
  const u = ctx.user || ctx.callback?.user || ctx.message?.sender || ctx.update?.callback?.user;
  return { username: u?.username || '', firstName: u?.first_name || u?.name || '', lastName: u?.last_name || '' };
}

async function reply(ctx: any, text: string, kb?: any) {
  try { await ctx.reply(text, kb ? { attachments: [kb] } : undefined); } catch (e) { log('ERROR', 'reply', e); }
}

async function notify(msg: string) {
  try { await bot.api.sendMessageToChat(parseInt(CHANNEL_ID), msg); } catch {
    try { await bot.api.sendMessageToChat(ADMIN_ID, msg); } catch {}
  }
}

// ============== MIDDLEWARE ==============
bot.use(async (ctx, next) => {
  const id = uid(ctx);
  const cb = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  
  if (!id) return next();
  if (['c_yes', 'c_no'].includes(cb)) return next();
  
  await getOrCreateUser(id, udata(ctx));
  
  if (!(await hasConsent(id))) {
    await reply(ctx, MSG.consent, KB.consent);
    return;
  }
  return next();
});

// ============== EVENTS ==============
bot.on('bot_started', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  await clearState(id);
  await reply(ctx, MSG.welcome, KB.main);
});

bot.command('start', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  await clearState(id);
  await reply(ctx, MSG.welcome, KB.main);
});

bot.command('waitlist', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'w', 'name', {}); await reply(ctx, 'Имя?'); });
bot.command('order', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.order, KB.back); });
bot.command('question', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'q', 'name', {}); await reply(ctx, 'Имя?'); });
bot.command('feldsher', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'f', 'name', {}); await reply(ctx, 'Имя?'); });
bot.command('doveren', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.doveren, KB.back); });
bot.command('podderzhka', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.podr, KB.podr); });
bot.command('revoke', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.revoke, KB.revoke); });
bot.command('privacy', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.priv, KB.back); });
bot.command('channels', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, MSG.chans, KB.chans); });

// ============== CALLBACKS ==============
bot.action('c_yes', async ctx => { const id = uid(ctx); if (!id) return; await getOrCreateUser(id, udata(ctx)); await setConsent(id, true); await reply(ctx, '✅ Спасибо!', KB.main); });
bot.action('c_no', async ctx => { const id = uid(ctx); if (!id) return; await reply(ctx, '❌ Без согласия недоступно. /start'); });

bot.action('menu', async ctx => { const id = uid(ctx); if (!id) return; await clearState(id); await reply(ctx, MSG.welcome, KB.main); });
bot.action('cancel', async ctx => { const id = uid(ctx); if (!id) return; await clearState(id); await reply(ctx, 'Отменено', KB.main); });
bot.action('doveren', async ctx => { await reply(ctx, MSG.doveren, KB.back); });
bot.action('podderzhka', async ctx => { await reply(ctx, MSG.podr, KB.podr); });
bot.action('privacy', async ctx => { await reply(ctx, MSG.priv, KB.back); });
bot.action('channels', async ctx => { await reply(ctx, MSG.chans, KB.chans); });
bot.action('revoke', async ctx => { await reply(ctx, MSG.revoke, KB.revoke); });

bot.action('order', async ctx => { await reply(ctx, MSG.order, KB.back); });

bot.action('w_start', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'w', 'name', {}); await reply(ctx, 'Имя?', KB.cancel); });
bot.action('q_start', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'q', 'name', {}); await reply(ctx, 'Имя?', KB.cancel); });
bot.action('f_start', async ctx => { const id = uid(ctx); if (!id) return; await setState(id, 'f', 'name', {}); await reply(ctx, 'Имя?', KB.cancel); });

bot.action('ch_p', async ctx => { await reply(ctx, `👥 Пациентам:\n\n🟪 https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8\n🔵 https://vk.com/feldsherryadom`); });
bot.action('ch_f', async ctx => { await reply(ctx, `👨‍⚕️ Фельдшерам:\n\n🟪 https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8\n🔵 https://vk.com/feldsherizh`); });
bot.action('sber', async ctx => { await reply(ctx, `💳 Сбербанк:\n\nhttps://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM\n📞 +7 (965) 843-78-18`); });
bot.action('planeta', async ctx => { await reply(ctx, `🌍 Planeta:\n\nhttps://planeta.ru/campaigns/feldsherryadom\n\nСпасибо! ❤️`); });

bot.action('revoke_yes', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  await delUser(id);
  await reply(ctx, '✅ Согласие отозвано, данные удалены.\n\n/start чтобы начать заново.');
});

// District
bot.action(/d_(\d)/, async ctx => {
  const id = uid(ctx);
  if (!id) return;
  const m = ctx.callback?.payload?.match(/d_(\d)/);
  if (!m) return;
  const d = DISTRICTS.find(x => x.id === m[1]);
  if (!d) return;
  const st = await getState(id);
  if (!st || st.flow !== 'w') return;
  st.data.district = d.name;
  await setState(id, 'w', 'confirm', st.data);
  await reply(ctx, `📍 ${d.name}\n\n👤 ${st.data.name}\n📞 ${st.data.phone}`, KB.confirm);
});

// Schedule
bot.action('s16', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  const st = await getState(id);
  if (!st || st.flow !== 'f') return;
  st.data.schedule = '16 смен';
  await setState(id, 'f', 'resume', st.data);
  await reply(ctx, `📅 16 смен\n\n📎 Резюме (или «нет»)`, KB.cancel);
});

bot.action('s12', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  const st = await getState(id);
  if (!st || st.flow !== 'f') return;
  st.data.schedule = '12 смен';
  await setState(id, 'f', 'resume', st.data);
  await reply(ctx, `📅 12 смен\n\n📎 Резюме (или «нет»)`, KB.cancel);
});

// Confirm
bot.action('confirm', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  const st = await getState(id);
  if (!st) return;
  
  try {
    if (st.flow === 'w') {
      await saveWaitlist(id, st.data);
      await notify(`📋 Заявка:\n👤 ${st.data.name}\n📞 ${decrypt(st.data.phone)}\n📍 ${st.data.district}`);
      await reply(ctx, '✅ Записаны в лист ожидания!', KB.main);
    } else if (st.flow === 'f') {
      await saveFeldsher(id, st.data);
      await notify(`👨‍⚕️ Фельдшер:\n👤 ${st.data.name}\n📞 ${decrypt(st.data.phone)}\n⏳ ${st.data.exp}`);
      await reply(ctx, '✅ Анкета отправлена!', KB.main);
    } else if (st.flow === 'q') {
      await saveQ(id, st.data);
      await notify(`❓ Вопрос:\n👤 ${st.data.name}\n📞 ${decrypt(st.data.phone)}\n💬 ${st.data.q}`);
      await reply(ctx, '✅ Вопрос отправлен!', KB.main);
    }
    await clearState(id);
  } catch (e) {
    log('ERROR', 'confirm', e);
    await reply(ctx, '❌ Ошибка', KB.main);
  }
});

// ============== MESSAGE ==============
bot.on('message_created', async ctx => {
  const id = uid(ctx);
  const txt = ctx.message?.body?.text || ctx.message?.text || '';
  if (!id || !txt) return;
  
  const st = await getState(id);
  
  if (!st) {
    if (txt.toLowerCase().includes('отозвать')) {
      await reply(ctx, MSG.revoke, KB.revoke);
      return;
    }
    await reply(ctx, MSG.welcome, KB.main);
    return;
  }
  
  const s = sanitize(txt, 500);
  
  if (st.flow === 'w') {
    if (st.step === 'name') { st.data.name = s; await setState(id, 'w', 'phone', st.data); await reply(ctx, '📞 Телефон?', KB.cancel); }
    else if (st.step === 'phone') {
      if (!validPhone(txt)) { await reply(ctx, '❌ Неверный формат'); return; }
      st.data.phone = fmtPhone(txt);
      await setState(id, 'w', 'district', st.data);
      await reply(ctx, '📍 Район:', KB.districts);
    }
  } else if (st.flow === 'f') {
    if (st.step === 'name') { st.data.name = s; await setState(id, 'f', 'phone', st.data); await reply(ctx, '📞 Телефон?', KB.cancel); }
    else if (st.step === 'phone') {
      if (!validPhone(txt)) { await reply(ctx, '❌ Неверный формат'); return; }
      st.data.phone = fmtPhone(txt);
      await setState(id, 'f', 'exp', st.data);
      await reply(ctx, '⏳ Стаж (лет)?', KB.cancel);
    } else if (st.step === 'exp') {
      if (!validExp(txt)) { await reply(ctx, '❌ Число лет'); return; }
      st.data.exp = txt.replace(/\D/g, '') + ' лет';
      await setState(id, 'f', 'schedule', st.data);
      await reply(ctx, '📅 График:', KB.schedule);
    } else if (st.step === 'resume') {
      st.data.resume = s;
      await setState(id, 'f', 'confirm', st.data);
      await reply(ctx, `👤 ${st.data.name}\n📞 ${st.data.phone}\n⏳ ${st.data.exp}\n📅 ${st.data.schedule}\n📎 ${st.data.resume}`, KB.confirm);
    }
  } else if (st.flow === 'q') {
    if (st.step === 'name') { st.data.name = s; await setState(id, 'q', 'phone', st.data); await reply(ctx, '📞 Телефон?', KB.cancel); }
    else if (st.step === 'phone') {
      if (!validPhone(txt)) { await reply(ctx, '❌ Неверный формат'); return; }
      st.data.phone = fmtPhone(txt);
      await setState(id, 'q', 'question', st.data);
      await reply(ctx, '❓ Вопрос?', KB.cancel);
    } else if (st.step === 'question') {
      st.data.q = s;
      await setState(id, 'q', 'confirm', st.data);
      await reply(ctx, `👤 ${st.data.name}\n📞 ${st.data.phone}\n❓ ${st.data.q}`, KB.confirm);
    }
  }
});

// ============== ERROR ==============
bot.catch(e => log('ERROR', 'bot', e));

// ============== START ==============
async function start() {
  try {
    log('INFO', 'Starting v11.6...');
    log('INFO', `DB: ${dbPath}`);
    
    const ok = await initDB();
    if (!ok) { log('ERROR', 'DB failed'); process.exit(1); }
    
    await bot.start();
    log('INFO', 'Started!');
    await notify(`🤖 Бот v11.6 запущен!\n🕐 ${new Date().toISOString()}`);
  } catch (e) {
    log('ERROR', 'start', e);
    process.exit(1);
  }
}

start();
