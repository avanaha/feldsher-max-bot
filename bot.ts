#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 11.5
 * 
 * v11.5:
 * - Добавлена переменная FRESH_DB=true для пересоздания базы
 * - Исправлен формат дат в SQL таблицах
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ============== CONFIG ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '162749713');
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || '-72328888338961';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'feldsher-encryption-key-2024';

// ============== LOGGING ==============
const LOG_DIR = '/app/data/logs';
const LOG_FILE = join(LOG_DIR, 'bot.log');
const SECURITY_LOG_FILE = join(LOG_DIR, 'security.log');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function log(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  try { appendFileSync(LOG_FILE, logLine); } catch (e) {}
  console.log(`[${level}] ${message}`, data || '');
}

function securityLog(action: string, userId: number, details?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] USER:${userId} ACTION:${action}${details ? ' | ' + JSON.stringify(details) : ''}\n`;
  try { appendFileSync(SECURITY_LOG_FILE, logLine); } catch (e) {}
  log('SECURITY', `User ${userId}: ${action}`, details);
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
  } catch (e) {
    return encryptedText;
  }
}

// ============== RATE LIMITING ==============
const rateLimitMap = new Map<number, { count: number; lastRequest: number }>();
const activeQuestionnaires = new Set<number>();

function checkRateLimit(userId: number): boolean {
  if (activeQuestionnaires.has(userId)) return true;
  
  const now = Date.now();
  const record = rateLimitMap.get(userId);
  
  if (!record || now - record.lastRequest > 60000) {
    rateLimitMap.set(userId, { count: 1, lastRequest: now });
    return true;
  }
  
  if (record.count >= 30) return false;
  
  record.count++;
  return true;
}

// ============== VALIDATION ==============
function sanitizeInput(text: string, maxLength: number = 500): string {
  if (!text) return '';
  return text.trim().substring(0, maxLength).replace(/<script|javascript:|on\w+=/gi, '');
}

function validatePhone(text: string): boolean {
  const cleaned = text.replace(/\D/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}

function formatPhone(text: string): string {
  const cleaned = text.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `+7 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 8)}-${cleaned.slice(8)}`;
  }
  if (cleaned.length === 11 && (cleaned[0] === '7' || cleaned[0] === '8')) {
    const digits = cleaned.slice(1);
    return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
  }
  return text;
}

function validateExperience(text: string): boolean {
  const years = parseInt(text.replace(/\D/g, ''));
  return !isNaN(years) && years >= 0 && years <= 50;
}

function validateUrl(text: string): string {
  if (!text) return '';
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'нет' || trimmed === '-') return 'Резюме не предоставлено';
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    return url.href;
  } catch {
    return sanitizeInput(text, 500);
  }
}

// ============== DATABASE ==============
const dataDir = '/app/data';
const dbPath = join(dataDir, 'database.sqlite');

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// ============== СОЗДАНИЕ ТАБЛИЦ ==============
async function initDatabase() {
  try {
    // Если FRESH_DB=true - удаляем старую базу
    if (process.env.FRESH_DB === 'true' && existsSync(dbPath)) {
      log('INFO', 'FRESH_DB=true - removing old database...');
      unlinkSync(dbPath);
      log('INFO', 'Old database removed');
    }
    
    log('INFO', 'Creating database tables...');
    
    // Используем Prisma для создания таблиц через сырой SQL
    // с форматом дат, совместимым с Prisma
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxUser (
        id TEXT PRIMARY KEY,
        maxId TEXT UNIQUE NOT NULL,
        username TEXT,
        firstName TEXT,
        lastName TEXT,
        hasConsent INTEGER DEFAULT 0,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now'))
      )
    `);
    
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS MaxUserState (
        id TEXT PRIMARY KEY,
        maxUserId TEXT UNIQUE NOT NULL,
        currentStep TEXT NOT NULL,
        flowType TEXT NOT NULL,
        data TEXT,
        createdAt TEXT DEFAULT (datetime('now')),
        updatedAt TEXT DEFAULT (datetime('now')),
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
        createdAt TEXT DEFAULT (datetime('now')),
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
        createdAt TEXT DEFAULT (datetime('now')),
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
        createdAt TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (maxUserId) REFERENCES MaxUser(id) ON DELETE CASCADE
      )
    `);
    
    log('INFO', 'Database tables created successfully');
    return true;
  } catch (error: any) {
    log('ERROR', 'Database init failed', { message: error.message, code: error.code });
    return false;
  }
}

const prisma = new PrismaClient({ log: ['error'] });

// ============== BOT CONFIG ==============
const BOT_CONFIG = {
  token: process.env.MAX_BOT_TOKEN || '',
  adminId: ADMIN_ID,
  channelId: CHANNEL_ID,
  port: parseInt(process.env.PORT || '8080'),
  districts: [
    { id: '1', name: 'Индустриальный' },
    { id: '2', name: 'Ленинский' },
    { id: '3', name: 'Октябрьский' },
    { id: '4', name: 'Первомайский' },
    { id: '5', name: 'Устиновский' },
  ],
};

if (!BOT_CONFIG.token) {
  log('ERROR', 'MAX_BOT_TOKEN not set!');
  process.exit(1);
}

const bot = new Bot(BOT_CONFIG.token);

// ============== DATABASE FUNCTIONS ==============

async function getOrCreateUser(maxId: number, userData: any) {
  const existing = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
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

async function hasUserConsent(maxId: number): Promise<boolean> {
  try {
    const user = await prisma.maxUser.findUnique({
      where: { maxId: maxId.toString() },
      select: { hasConsent: true },
    });
    return user?.hasConsent ?? false;
  } catch {
    return false;
  }
}

async function setUserConsent(maxId: number, consent: boolean) {
  return prisma.maxUser.update({
    where: { maxId: maxId.toString() },
    data: { hasConsent: consent },
  });
}

async function deleteAllUserData(maxId: number) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) return false;
  await prisma.maxUserState.deleteMany({ where: { maxUserId: user.id } });
  await prisma.maxWaitlistEntry.deleteMany({ where: { maxUserId: user.id } });
  await prisma.maxFeldsherApplication.deleteMany({ where: { maxUserId: user.id } });
  await prisma.maxQuestion.deleteMany({ where: { maxUserId: user.id } });
  await prisma.maxUser.delete({ where: { id: user.id } });
  return true;
}

async function getUserState(maxId: number) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
    include: { state: true },
  });
  if (!user?.state) return null;
  return {
    flowType: user.state.flowType,
    currentStep: user.state.currentStep,
    data: JSON.parse(user.state.data || '{}'),
  };
}

async function setUserState(maxId: number, flowType: string, currentStep: string, data: any) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) return null;
  activeQuestionnaires.add(maxId);
  return prisma.maxUserState.upsert({
    where: { maxUserId: user.id },
    create: { maxUserId: user.id, flowType, currentStep, data: JSON.stringify(data) },
    update: { flowType, currentStep, data: JSON.stringify(data) },
  });
}

async function clearUserState(maxId: number) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (user) {
    await prisma.maxUserState.deleteMany({ where: { maxUserId: user.id } });
  }
  activeQuestionnaires.delete(maxId);
}

async function saveWaitlistEntry(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxWaitlistEntry.create({
    data: {
      maxUserId: user.id,
      name: sanitizeInput(data.name, 100),
      phone: encrypt(data.phone),
      district: sanitizeInput(data.district, 50),
    },
  });
}

async function saveFeldsherApplication(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxFeldsherApplication.create({
    data: {
      maxUserId: user.id,
      name: sanitizeInput(data.name, 100),
      phone: encrypt(data.phone),
      experience: sanitizeInput(data.experience, 10),
      scheduleType: sanitizeInput(data.scheduleType, 50),
      resumeLink: sanitizeInput(data.resumeLink, 500) || null,
    },
  });
}

async function saveQuestion(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({ where: { maxId: maxId.toString() } });
  if (!user) throw new Error('User not found');
  return prisma.maxQuestion.create({
    data: {
      maxUserId: user.id,
      name: sanitizeInput(data.name, 100),
      phone: encrypt(data.phone),
      question: sanitizeInput(data.question, 1000),
    },
  });
}

// ============== KEYBOARDS ==============

const ConsentKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Согласен', 'consent_yes')],
  [Keyboard.button.callback('❌ Не согласен', 'consent_no')],
]);

const MainKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 Хочу в лист ожидания', 'patient_waitlist')],
  [Keyboard.button.callback('💰 Оплатить предзаказ', 'patient_order')],
  [Keyboard.button.callback('❓ У меня есть вопрос', 'question_ask')],
  [Keyboard.button.callback('👨‍⚕️ Фельдшеру (отправить резюме)', 'feldsher_apply')],
  [Keyboard.button.callback('📄 Текст доверенности', 'menu_doveren')],
  [Keyboard.button.callback('❤️ Поддержать проект', 'menu_podderzhka')],
  [Keyboard.button.callback('🗑️ Отозвать согласие', 'menu_revoke')],
  [Keyboard.button.callback('🔐 Свод правил', 'menu_privacy')],
  [Keyboard.button.callback('📢 Наши каналы', 'menu_channels')],
]);

const CancelKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❌ Отмена', 'cancel_flow')],
]);

const BackKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const DistrictsKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('Индустриальный', 'district_1')],
  [Keyboard.button.callback('Ленинский', 'district_2')],
  [Keyboard.button.callback('Октябрьский', 'district_3')],
  [Keyboard.button.callback('Первомайский', 'district_4')],
  [Keyboard.button.callback('Устиновский', 'district_5')],
]);

const ScheduleKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('16 смен (основной фельдшер)', 'schedule_main')],
  [Keyboard.button.callback('12 смен (воскресный фельдшер)', 'schedule_sunday')],
]);

const ConfirmKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Отправить', 'confirm_submit')],
  [Keyboard.button.callback('❌ Не отправлять', 'cancel_flow')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const RevokeKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❌ Отозвать согласие', 'revoke_confirm')],
  [Keyboard.button.callback('✅ Не отзывать согласие', 'main_menu')],
]);

const PodderzhkaKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('💳 Сбербанк', 'podderzhka_sber')],
  [Keyboard.button.callback('🌍 Planeta.ru', 'podderzhka_planeta')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const ChannelsKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('👥 Пациентам', 'channel_patient')],
  [Keyboard.button.callback('👨‍⚕️ Фельдшерам', 'channel_feldsher')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

// ============== MESSAGES ==============

const CONSENT_MESSAGE = `Этот бот — ваш помощник в проекте «Фельдшеръ.Рядом».

Он позволяет:

🏥 Пациентам:
📋 Записаться в лист ожидания открытия кабинета, получить скидку на подписку.
💰 Оплатить предзаказ (скидка - 20%, ограниченное предложение).
❓ Задать любой вопрос – мы ответим лично.

👨‍⚕️ Фельдшерам: оставить контакты и резюме для сотрудничества.

❤️ Поддержать проект.

Все сообщения мгновенно поступают администратору.
Бот работает 24/7, администратор отвечает с 07.00 до 20.00 (время МСК).

Чтобы начать пользоваться ботом, примите согласие на обработку персональных данных

✅ СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ

Я, заполняя форму в боте по ссылке https://max.ru/id1800048162_1_bot, даю своё добровольное и информированное согласие ООО «Фельдшер и Ко» (ИНН 1800048162, ОГРН 1261800002694) на обработку моих персональных данных (имя, номер телефона, район, опыт работы, ссылка на резюме) с целями:
– формирования листа ожидания;
– связи со мной;
– рассмотрения кандидатуры фельдшера;
– ответа на вопросы.

Обработка включает: сбор, запись, хранение, использование, передачу, удаление персональных данных.

Политика конфиденциальности: /privacy или https://feldsher-land.ru/legal

Нажимая «✅ Согласен», подтверждаю, что прочитал(а) и принимаю условия.`;

const WELCOME_MESSAGE = `👋 Здравствуйте! Я бот проекта «Фельдшеръ.Рядом».

Я помогу:
📋 записаться в лист ожидания открытия кабинета,
❓ задать вопрос о проекте,
👨‍⚕️ оставить резюме фельдшеру,
❤️ поддержать проект.

Выберите, что вас интересует:`;

const ORDER_MESSAGE = `💰 ОПЛАТА ПРЕДЗАКАЗА

Для оплаты предзаказа воспользуйтесь ссылкой:
[Ссылка будет добавлена позже]

Вопросы: 📧 feldland@yandex.ru`;

const DOVEREN_MESSAGE = `📄 ДОВЕРЕННОСТЬ

Я, (ФИО доверителя), паспортные данные полностью
доверяю (ФИО доверенного лица), паспортные данные полностью
сопровождать моего ребёнка (ФИО ребёнка, дата рождения)
в медицинский кабинет «Фельдшеръ.Рядом» (ООО «Фельдшер и компания»)
для получения доврачебной медицинской помощи.

Доверенность действительна по (ДАТА)
ПОДПИСЬ, РАСШИФРОВКА
(ДАТА НАПИСАНИЯ)`;

const PODDERZHKA_MESSAGE = `Спасибо за желание помочь проекту! ❤️

🌍 Краудфандинг:
https://planeta.ru/campaigns/feldsherryadom

💳 Сбербанк:
https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

📞 Телефон: +7 (965) 843-78-18`;

const PRIVACY_MESSAGE = `Политика конфиденциальности:
https://feldsher-land.ru/legal

🔐 Согласие на обработку ПД:
Принимается перед использованием бота.`;

const CHANNELS_MESSAGE = `📢 Наши каналы:

Пациентам:
🟪 MAX: https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8
🔵 VK: https://vk.com/feldsherryadom

Фельдшерам:
🟪 MAX: https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8
🔵 VK: https://vk.com/feldsherizh`;

const REVOKE_MESSAGE = `Вы можете отозвать согласие на обработку персональных данных.

Если вы отзовёте согласие, все ваши данные будут удалены.

Отозвать согласие?`;

// ============== HELPERS ==============

function getUserId(ctx: any): number | null {
  if (ctx.user?.user_id) return ctx.user.user_id;
  if (ctx.user?.id) return ctx.user.id;
  if (ctx.callback?.user?.user_id) return ctx.callback.user.user_id;
  if (ctx.message?.sender?.user_id) return ctx.message.sender.user_id;
  if (ctx.update?.callback?.user?.user_id) return ctx.update.callback.user.user_id;
  if (ctx.update?.message?.sender?.user_id) return ctx.update.message.sender.user_id;
  return null;
}

function getUserData(ctx: any): any {
  const user = ctx.user || ctx.callback?.user || ctx.message?.sender || ctx.update?.callback?.user;
  return {
    username: user?.username || '',
    firstName: user?.first_name || user?.name || '',
    lastName: user?.last_name || '',
  };
}

async function safeReply(ctx: any, text: string, options?: any): Promise<boolean> {
  try {
    await ctx.reply(text, options);
    return true;
  } catch (error: any) {
    if (error.code === 'chat.denied') {
      const userId = getUserId(ctx);
      if (userId) await deleteAllUserData(userId);
      return false;
    }
    throw error;
  }
}

async function sendNotification(message: string) {
  try {
    await bot.api.sendMessageToChat(parseInt(CHANNEL_ID), message);
  } catch {
    try {
      await bot.api.sendMessageToChat(ADMIN_ID, message);
    } catch (e) {
      log('ERROR', 'Notification failed', e);
    }
  }
}

async function notifyAdmin(type: string, data: any) {
  const phone = decrypt(data.phone);
  let message = '';
  
  if (type === 'waitlist') {
    message = `📋 Новая заявка:\n👤 ${data.name}\n📞 ${phone}\n📍 ${data.district}`;
  } else if (type === 'feldsher') {
    message = `👨‍⚕️ Новая анкета фельдшера:\n👤 ${data.name}\n📞 ${phone}\n⏳ ${data.experience}\n📅 ${data.scheduleType}`;
  } else if (type === 'question') {
    message = `❓ Новый вопрос:\n👤 ${data.name}\n📞 ${phone}\n💬 ${data.question}`;
  }
  
  if (message) await sendNotification(message);
}

// ============== MIDDLEWARE ==============

bot.use(async (ctx, next) => {
  const id = getUserId(ctx);
  if (id && !checkRateLimit(id)) return;
  return next();
});

bot.use(async (ctx, next) => {
  const id = getUserId(ctx);
  const callbackData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  
  if (!id) return next();
  if (['consent_yes', 'consent_no', 'consent_retry'].includes(callbackData)) return next();

  await getOrCreateUser(id, getUserData(ctx));
  
  if (!(await hasUserConsent(id))) {
    try {
      await ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
    } catch (e) {}
    return;
  }

  return next();
});

// ============== BOT EVENTS ==============

bot.on('bot_started', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

// ============== COMMANDS ==============

bot.command('start', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'waitlist', 'name', {});
  await safeReply(ctx, 'Напишите имя');
});

bot.command('order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'question', 'name', {});
  await safeReply(ctx, 'Напишите ваше имя');
});

bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'feldsher', 'name', {});
  await safeReply(ctx, 'Как вас зовут?');
});

bot.command('doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, DOVEREN_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PODDERZHKA_MESSAGE, { attachments: [PodderzhkaKeyboard] });
});

bot.command('revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PRIVACY_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, CHANNELS_MESSAGE, { attachments: [ChannelsKeyboard] });
});

// ============== CALLBACKS ==============

bot.action('consent_yes', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  await setUserConsent(id, true);
  securityLog('CONSENT_GRANTED', id);
  await safeReply(ctx, '✅ Спасибо за согласие!', { attachments: [MainKeyboard] });
});

bot.action('consent_no', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, '❌ Без согласия функционал недоступен. /start чтобы начать снова.');
});

bot.action('main_menu', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

bot.action('menu_doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, DOVEREN_MESSAGE, { attachments: [BackKeyboard] });
});

bot.action('menu_podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PODDERZHKA_MESSAGE, { attachments: [PodderzhkaKeyboard] });
});

bot.action('menu_revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

bot.action('menu_privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PRIVACY_MESSAGE, { attachments: [BackKeyboard] });
});

bot.action('menu_channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, CHANNELS_MESSAGE, { attachments: [ChannelsKeyboard] });
});

bot.action('patient_waitlist', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'waitlist', 'name', {});
  await safeReply(ctx, 'Напишите имя');
});

bot.action('patient_order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

bot.action('question_ask', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'question', 'name', {});
  await safeReply(ctx, 'Напишите ваше имя');
});

bot.action('feldsher_apply', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'feldsher', 'name', {});
  await safeReply(ctx, 'Как вас зовут?');
});

bot.action('channel_patient', async (ctx) => {
  await safeReply(ctx, `👥 Канал для пациентов:\n\n🟪 MAX\nhttps://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8\n\n🔵 VK\nhttps://vk.com/feldsherryadom`);
});

bot.action('channel_feldsher', async (ctx) => {
  await safeReply(ctx, `👨‍⚕️ Канал для фельдшеров:\n\n🟪 MAX\nhttps://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8\n\n🔵 VK\nhttps://vk.com/feldsherizh`);
});

bot.action('podderzhka_sber', async (ctx) => {
  await safeReply(ctx, `💳 Сбербанк:\n\nhttps://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM\n\n📞 +7 (965) 843-78-18`);
});

bot.action('podderzhka_planeta', async (ctx) => {
  await safeReply(ctx, `🌍 Planeta.ru:\n\nhttps://planeta.ru/campaigns/feldsherryadom\n\nСпасибо! ❤️`);
});

bot.action('revoke_confirm', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  securityLog('CONSENT_REVOKED', id);
  await deleteAllUserData(id);
  await safeReply(ctx, `✅ Согласие отозвано. Данные удалены.\n\n/start чтобы начать заново.`);
});

bot.action('cancel_flow', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await safeReply(ctx, '❌ Отменено.', { attachments: [MainKeyboard] });
});

bot.action(/district_(\d+)/, async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  const match = ctx.callback?.payload?.match(/district_(\d+)/);
  if (!match) return;
  const district = BOT_CONFIG.districts.find(d => d.id === match[1]);
  if (!district) return;
  const state = await getUserState(id);
  if (!state || state.flowType !== 'waitlist') return;
  state.data.district = district.name;
  await setUserState(id, 'waitlist', 'confirm', state.data);
  await safeReply(ctx, `📍 Район: ${district.name}\n\n✅ Проверьте:\n👤 ${state.data.name}\n📞 ${state.data.phone}\n📍 ${district.name}`, { attachments: [ConfirmKeyboard] });
});

bot.action('schedule_main', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  state.data.scheduleType = '16 смен (основной)';
  await setUserState(id, 'feldsher', 'resume', state.data);
  await safeReply(ctx, `📅 16 смен (основной фельдшер)\n\n📎 Ссылка на резюме (или «нет»)`, { attachments: [CancelKeyboard] });
});

bot.action('schedule_sunday', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  state.data.scheduleType = '12 смен (воскресный)';
  await setUserState(id, 'feldsher', 'resume', state.data);
  await safeReply(ctx, `📅 12 смен (воскресный фельдшер)\n\n📎 Ссылка на резюме (или «нет»)`, { attachments: [CancelKeyboard] });
});

bot.action('confirm_submit', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  const state = await getUserState(id);
  if (!state) return;
  
  try {
    if (state.flowType === 'waitlist') {
      await saveWaitlistEntry(id, state.data);
      await notifyAdmin('waitlist', state.data);
      await safeReply(ctx, '✅ Вы записаны в лист ожидания!', { attachments: [MainKeyboard] });
    } else if (state.flowType === 'feldsher') {
      await saveFeldsherApplication(id, state.data);
      await notifyAdmin('feldsher', state.data);
      await safeReply(ctx, '✅ Анкета отправлена!', { attachments: [MainKeyboard] });
    } else if (state.flowType === 'question') {
      await saveQuestion(id, state.data);
      await notifyAdmin('question', state.data);
      await safeReply(ctx, '✅ Вопрос отправлен! Ответим в рабочее время.', { attachments: [MainKeyboard] });
    }
    await clearUserState(id);
  } catch (e) {
    log('ERROR', 'Submit failed', e);
    await safeReply(ctx, '❌ Ошибка. Попробуйте позже.', { attachments: [MainKeyboard] });
  }
});

// ============== MESSAGE HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text || '';
  if (!id || !text) return;
  
  const state = await getUserState(id);
  
  if (!state) {
    if (text.toLowerCase().includes('отозвать') && text.toLowerCase().includes('согласие')) {
      await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
      return;
    }
    await safeReply(ctx, 'Выберите действие:', { attachments: [MainKeyboard] });
    return;
  }
  
  if (state.flowType === 'waitlist') {
    if (state.currentStep === 'name') {
      state.data.name = sanitizeInput(text, 100);
      await setUserState(id, 'waitlist', 'phone', state.data);
      await safeReply(ctx, '📞 Номер телефона', { attachments: [CancelKeyboard] });
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'waitlist', 'district', state.data);
      await safeReply(ctx, '📍 Выберите район:', { attachments: [DistrictsKeyboard] });
    }
  } else if (state.flowType === 'feldsher') {
    if (state.currentStep === 'name') {
      state.data.name = sanitizeInput(text, 100);
      await setUserState(id, 'feldsher', 'phone', state.data);
      await safeReply(ctx, '📞 Номер телефона', { attachments: [CancelKeyboard] });
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'feldsher', 'experience', state.data);
      await safeReply(ctx, '⏳ Стаж работы фельдшером (лет)?', { attachments: [CancelKeyboard] });
    } else if (state.currentStep === 'experience') {
      if (!validateExperience(text)) {
        await safeReply(ctx, '❌ Укажите число лет');
        return;
      }
      state.data.experience = text.replace(/\D/g, '') + ' лет';
      await setUserState(id, 'feldsher', 'schedule', state.data);
      await safeReply(ctx, '📅 Выберите график:', { attachments: [ScheduleKeyboard] });
    } else if (state.currentStep === 'resume') {
      state.data.resumeLink = validateUrl(text);
      await setUserState(id, 'feldsher', 'confirm', state.data);
      await safeReply(ctx, `✅ Проверьте:\n👤 ${state.data.name}\n📞 ${state.data.phone}\n⏳ ${state.data.experience}\n📅 ${state.data.scheduleType}\n📎 ${state.data.resumeLink || 'нет'}`, { attachments: [ConfirmKeyboard] });
    }
  } else if (state.flowType === 'question') {
    if (state.currentStep === 'name') {
      state.data.name = sanitizeInput(text, 100);
      await setUserState(id, 'question', 'phone', state.data);
      await safeReply(ctx, '📞 Номер телефона', { attachments: [CancelKeyboard] });
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'question', 'question', state.data);
      await safeReply(ctx, '❓ Ваш вопрос', { attachments: [CancelKeyboard] });
    } else if (state.currentStep === 'question') {
      state.data.question = sanitizeInput(text, 1000);
      await setUserState(id, 'question', 'confirm', state.data);
      await safeReply(ctx, `✅ Проверьте:\n👤 ${state.data.name}\n📞 ${state.data.phone}\n❓ ${state.data.question}`, { attachments: [ConfirmKeyboard] });
    }
  }
});

// ============== ERROR HANDLING ==============

bot.catch((error: any) => {
  log('ERROR', 'Bot error', error);
});

// ============== START ==============

async function startBot() {
  try {
    log('INFO', 'Starting bot v11.5...');
    log('INFO', `FRESH_DB: ${process.env.FRESH_DB}`);
    
    const dbOk = await initDatabase();
    if (!dbOk) {
      log('ERROR', 'Database init failed');
      process.exit(1);
    }
    
    await bot.start();
    log('INFO', 'Bot started!');
    
    await sendNotification(`🤖 Бот v11.5 запущен!\n🕐 ${new Date().toISOString()}`);
    
  } catch (error: any) {
    log('ERROR', 'Start failed', error);
    process.exit(1);
  }
}

startBot();
