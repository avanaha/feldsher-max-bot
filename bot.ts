#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom
 * Version: 11.7 - Финальная версия с String датами
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ============== CONFIG ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '162749713');
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || '-72328888338961';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'feldsher-key-2024';

// ============== DATABASE ==============
const DATA_DIR = '/app/data';
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Новый путь к базе
process.env.DATABASE_URL = `file:${join(DATA_DIR, 'feldsher.db')}`;

// ============== LOGGING ==============
const LOG_DIR = join(DATA_DIR, 'logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(level: string, msg: string, data?: any) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  try { appendFileSync(join(LOG_DIR, 'bot.log'), line); } catch {}
  console.log(`[${level}]`, msg, data || '');
}

// ============== ENCRYPTION ==============
const ALG = 'aes-256-cbc';
const KEY = scryptSync(ENCRYPTION_KEY, 'salt', 32);

function enc(text: string): string {
  if (!text) return '';
  const iv = randomBytes(16);
  const c = createCipheriv(ALG, KEY, iv);
  return iv.toString('hex') + ':' + (c.update(text, 'utf8', 'hex') + c.final('hex'));
}

function dec(text: string): string {
  if (!text) return '';
  try {
    const [iv, data] = text.split(':');
    if (!data) return text;
    const d = createDecipheriv(ALG, KEY, Buffer.from(iv, 'hex'));
    return d.update(data, 'hex', 'utf8') + d.final('utf8');
  } catch { return text; }
}

// ============== VALIDATION ==============
const clean = (t: string, m = 500) => t?.trim().substring(0, m).replace(/<script/gi, '') || '';
const phoneOk = (t: string) => /^\+?\d{10,15}$/.test(t.replace(/\D/g, ''));
const fmtPhone = (t: string) => {
  const d = t.replace(/\D/g, '');
  return d.length === 10 ? `+7 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,8)}-${d.slice(8)}` :
         d.length === 11 ? `+7 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7,9)}-${d.slice(9)}` : t;
};
const expOk = (t: string) => { const n = parseInt(t.replace(/\D/g, '')); return !isNaN(n) && n >= 0 && n <= 50; };

// ============== PRISMA ==============
const prisma = new PrismaClient();

async function initDB() {
  log('INFO', 'Initializing database...');
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MaxUser (
      id TEXT PRIMARY KEY, maxId TEXT UNIQUE NOT NULL, username TEXT, firstName TEXT, lastName TEXT,
      hasConsent INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT)`);
    
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MaxUserState (
      id TEXT PRIMARY KEY, maxUserId TEXT UNIQUE NOT NULL, currentStep TEXT NOT NULL,
      flowType TEXT NOT NULL, data TEXT, createdAt TEXT, updatedAt TEXT,
      FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE)`);
    
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MaxWaitlistEntry (
      id TEXT PRIMARY KEY, maxUserId TEXT NOT NULL, name TEXT NOT NULL,
      phone TEXT NOT NULL, district TEXT NOT NULL, createdAt TEXT,
      FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE)`);
    
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MaxFeldsherApplication (
      id TEXT PRIMARY KEY, maxUserId TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
      experience TEXT NOT NULL, scheduleType TEXT NOT NULL, resumeLink TEXT, createdAt TEXT,
      FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE)`);
    
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS MaxQuestion (
      id TEXT PRIMARY KEY, maxUserId TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
      question TEXT NOT NULL, isAnswered INTEGER DEFAULT 0, createdAt TEXT,
      FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE)`);
    
    log('INFO', 'Database ready');
    return true;
  } catch (e: any) { log('ERROR', 'DB init failed', e.message); return false; }
}

// ============== DB FUNCTIONS ==============
const getUser = (id: number) => prisma.maxUser.findUnique({ where: { maxId: String(id) } });
const createUser = (id: number, d: any) => prisma.maxUser.create({
  data: { maxId: String(id), username: clean(d.username, 100), firstName: clean(d.firstName, 100), lastName: clean(d.lastName, 100) }
});
const getOrCreateUser = async (id: number, d: any) => (await getUser(id)) || createUser(id, d);
const hasConsent = async (id: number) => (await getUser(id))?.hasConsent ?? false;
const setConsent = (id: number, v: boolean) => prisma.maxUser.update({ where: { maxId: String(id) }, data: { hasConsent: v } });

async function delUser(id: number) {
  const u = await getUser(id);
  if (!u) return false;
  await prisma.maxUserState.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxWaitlistEntry.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxFeldsherApplication.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxQuestion.deleteMany({ where: { maxUserId: u.id } });
  await prisma.maxUser.delete({ where: { id: u.id } });
  return true;
}

async function getState(id: number) {
  const u = await prisma.maxUser.findUnique({ where: { maxId: String(id) }, include: { state: true } });
  return u?.state ? { flow: u.state.flowType, step: u.state.currentStep, data: JSON.parse(u.state.data || '{}') } : null;
}

async function setState(id: number, flow: string, step: string, data: any) {
  const u = await getUser(id);
  if (!u) return;
  await prisma.maxUserState.upsert({
    where: { maxUserId: u.id },
    create: { maxUserId: u.id, flowType: flow, currentStep: step, data: JSON.stringify(data), createdAt: new Date().toISOString() },
    update: { flowType: flow, currentStep: step, data: JSON.stringify(data), updatedAt: new Date().toISOString() }
  });
}

const clearState = async (id: number) => { const u = await getUser(id); if (u) await prisma.maxUserState.deleteMany({ where: { maxUserId: u.id } }); };

async function saveWaitlist(id: number, d: any) {
  const u = await getUser(id);
  if (!u) return;
  await prisma.maxWaitlistEntry.create({
    data: { maxUserId: u.id, name: clean(d.name, 100), phone: enc(d.phone), district: clean(d.district, 50), createdAt: new Date().toISOString() }
  });
}

async function saveFeldsher(id: number, d: any) {
  const u = await getUser(id);
  if (!u) return;
  await prisma.maxFeldsherApplication.create({
    data: { maxUserId: u.id, name: clean(d.name, 100), phone: enc(d.phone), experience: clean(d.exp, 10),
      scheduleType: clean(d.schedule, 50), resumeLink: clean(d.resume, 500) || null, createdAt: new Date().toISOString() }
  });
}

async function saveQ(id: number, d: any) {
  const u = await getUser(id);
  if (!u) return;
  await prisma.maxQuestion.create({
    data: { maxUserId: u.id, name: clean(d.name, 100), phone: enc(d.phone), question: clean(d.q, 1000), createdAt: new Date().toISOString() }
  });
}

// ============== BOT ==============
const TOKEN = process.env.MAX_BOT_TOKEN || '';
if (!TOKEN) { log('ERROR', 'No MAX_BOT_TOKEN'); process.exit(1); }
const bot = new Bot(TOKEN);

const DISTRICTS = [
  { id: '1', name: 'Индустриальный' }, { id: '2', name: 'Ленинский' },
  { id: '3', name: 'Октябрьский' }, { id: '4', name: 'Первомайский' }, { id: '5', name: 'Устиновский' }
];

// ============== KEYBOARDS ==============
const KB = {
  consent: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Согласен', 'c_yes')],
    [Keyboard.button.callback('❌ Не согласен', 'c_no')],
  ]),
  main: Keyboard.inlineKeyboard([
    [Keyboard.button.callback('📋 Лист ожидания', 'w_start')],
    [Keyboard.button.callback('💰 Предзаказ', 'order')],
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
    [Keyboard.button.callback('16 смен (основной)', 's16')],
    [Keyboard.button.callback('12 смен (воскресный)', 's12')],
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
в кабинет «Фельдшеръ.Рядом».

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
const uid = (ctx: any) => ctx.user?.user_id || ctx.user?.id || ctx.callback?.user?.user_id || ctx.message?.sender?.user_id || ctx.update?.callback?.user?.user_id || ctx.update?.message?.sender?.user_id || null;
const udata = (ctx: any) => { const u = ctx.user || ctx.callback?.user || ctx.message?.sender || ctx.update?.callback?.user; return { username: u?.username || '', firstName: u?.first_name || u?.name || '', lastName: u?.last_name || '' }; };
const reply = async (ctx: any, text: string, kb?: any) => { try { await ctx.reply(text, kb ? { attachments: [kb] } : undefined); } catch {}; };
const notify = async (msg: string) => { try { await bot.api.sendMessageToChat(parseInt(CHANNEL_ID), msg); } catch { try { await bot.api.sendMessageToChat(ADMIN_ID, msg); } catch {} }; };

// ============== MIDDLEWARE ==============
bot.use(async (ctx, next) => {
  const id = uid(ctx);
  const cb = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  if (!id) return next();
  if (['c_yes', 'c_no'].includes(cb)) return next();
  
  await getOrCreateUser(id, udata(ctx));
  if (!(await hasConsent(id))) { await reply(ctx, MSG.consent, KB.consent); return; }
  return next();
});

// ============== EVENTS ==============
bot.on('bot_started', async ctx => { const id = uid(ctx); if (!id) return; await clearState(id); await reply(ctx, MSG.welcome, KB.main); });
bot.command('start', async ctx => { const id = uid(ctx); if (!id) return; await clearState(id); await reply(ctx, MSG.welcome, KB.main); });
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

bot.action('revoke_yes', async ctx => { const id = uid(ctx); if (!id) return; await delUser(id); await reply(ctx, '✅ Согласие отозвано.\n\n/start чтобы начать заново.'); });

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

bot.action('confirm', async ctx => {
  const id = uid(ctx);
  if (!id) return;
  const st = await getState(id);
  if (!st) return;
  
  try {
    if (st.flow === 'w') {
      await saveWaitlist(id, st.data);
      await notify(`📋 Заявка:\n👤 ${st.data.name}\n📞 ${dec(st.data.phone)}\n📍 ${st.data.district}`);
      await reply(ctx, '✅ Записаны в лист ожидания!', KB.main);
    } else if (st.flow === 'f') {
      await saveFeldsher(id, st.data);
      await notify(`👨‍⚕️ Фельдшер:\n👤 ${st.data.name}\n📞 ${dec(st.data.phone)}\n⏳ ${st.data.exp}`);
      await reply(ctx, '✅ Анкета отправлена!', KB.main);
    } else if (st.flow === 'q') {
      await saveQ(id, st.data);
      await notify(`❓ Вопрос:\n👤 ${st.data.name}\n📞 ${dec(st.data.phone)}\n💬 ${st.data.q}`);
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
    if (txt.toLowerCase().includes('отозвать')) { await reply(ctx, MSG.revoke, KB.revoke); return; }
    await reply(ctx, MSG.welcome, KB.main);
    return;
  }
  
  const s = clean(txt, 500);
  
  if (st.flow === 'w') {
    if (st.step === 'name') { st.data.name = s; await setState(id, 'w', 'phone', st.data); await reply(ctx, '📞 Телефон?', KB.cancel); }
    else if (st.step === 'phone') {
      if (!phoneOk(txt)) { await reply(ctx, '❌ Неверный формат телефона'); return; }
      st.data.phone = fmtPhone(txt);
      await setState(id, 'w', 'district', st.data);
      await reply(ctx, '📍 Район:', KB.districts);
    }
  } else if (st.flow === 'f') {
    if (st.step === 'name') { st.data.name = s; await setState(id, 'f', 'phone', st.data); await reply(ctx, '📞 Телефон?', KB.cancel); }
    else if (st.step === 'phone') {
      if (!phoneOk(txt)) { await reply(ctx, '❌ Неверный формат телефона'); return; }
      st.data.phone = fmtPhone(txt);
      await setState(id, 'f', 'exp', st.data);
      await reply(ctx, '⏳ Стаж (лет)?', KB.cancel);
    } else if (st.step === 'exp') {
      if (!expOk(txt)) { await reply(ctx, '❌ Число лет'); return; }
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
      if (!phoneOk(txt)) { await reply(ctx, '❌ Неверный формат телефона'); return; }
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

// ============== ERROR & START ==============
bot.catch(e => log('ERROR', 'bot', e));

async function start() {
  try {
    log('INFO', 'Starting v11.7...');
    
    // Удаляем старые базы с кривым форматом
    const oldDb = join(DATA_DIR, 'database.sqlite');
    const oldDb2 = join(DATA_DIR, 'bot.db');
    try { if (existsSync(oldDb)) unlinkSync(oldDb); } catch {}
    try { if (existsSync(oldDb2)) unlinkSync(oldDb2); } catch {}
    
    const ok = await initDB();
    if (!ok) { log('ERROR', 'DB failed'); process.exit(1); }
    
    await bot.start();
    log('INFO', 'Started!');
    await notify(`🤖 Бот v11.7 запущен!\n🕐 ${new Date().toISOString()}`);
  } catch (e) {
    log('ERROR', 'start', e);
    process.exit(1);
  }
}

start();
