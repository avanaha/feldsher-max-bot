#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 1.5 - Fixed keyboard format
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

// ============== LOGGING SYSTEM ==============
const LOG_DIR = '/app/data/logs';
const LOG_FILE = join(LOG_DIR, 'bot.log');
const SECURITY_LOG_FILE = join(LOG_DIR, 'security.log');

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function log(level: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  
  try {
    appendFileSync(LOG_FILE, logLine);
  } catch (e) {}
  
  console.log(`[${level}] ${message}`, data || '');
}

function securityLog(action: string, userId: number, details?: any) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] USER:${userId} ACTION:${action}${details ? ' | ' + JSON.stringify(details) : ''}\n`;
  
  try {
    appendFileSync(SECURITY_LOG_FILE, logLine);
  } catch (e) {}
  
  log('SECURITY', `User ${userId}: ${action}`, details);
}

// ============== INPUT VALIDATION ==============
const MAX_INPUT_LENGTH = 500;
const MAX_QUESTION_LENGTH = 1000;

function sanitizeInput(text: string, maxLength: number = MAX_INPUT_LENGTH): string {
  if (!text) return '';
  let sanitized = text.trim().substring(0, maxLength);
  sanitized = sanitized.replace(/<script|javascript:|on\w+=/gi, '');
  return sanitized;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============== ADMIN CHECK ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '0');

function isAdmin(userId: number): boolean {
  return userId === ADMIN_ID;
}

// ============== DATABASE SETUP ==============
const dataDir = '/app/data';
if (!existsSync(dataDir)) {
  try {
    mkdirSync(dataDir, { recursive: true });
    log('INFO', 'Created data directory');
  } catch (e) {
    log('ERROR', 'Could not create data directory', e);
  }
}

const prisma = new PrismaClient({
  log: ['error'],
});

// ============== CONFIGURATION ==============
const BOT_CONFIG = {
  token: process.env.MAX_BOT_TOKEN || '',
  adminId: ADMIN_ID,
  port: parseInt(process.env.PORT || '8080'),
  districts: [
    { id: '1', name: 'Индустриальный' },
    { id: '2', name: 'Ленинский' },
    { id: '3', name: 'Октябрьский' },
    { id: '4', name: 'Первомайский' },
    { id: '5', name: 'Устиновский' },
  ],
  scheduleOptions: {
    'schedule_16': 'Вариант 1 (16 смен)',
    'schedule_12': 'Вариант 2 (12 смен)',
  },
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

async function hasUserConsent(maxId: number) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
    select: { hasConsent: true },
  });
  return user?.hasConsent ?? false;
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
}

async function saveWaitlistEntry(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) throw new Error('User not found');
  
  return prisma.maxWaitlistEntry.create({
    data: { 
      maxUserId: user.id, 
      name: sanitizeInput(data.name, 100), 
      phone: sanitizeInput(data.phone, 20), 
      district: sanitizeInput(data.district, 50) 
    },
  });
}

async function saveFeldsherApplication(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) throw new Error('User not found');
  
  return prisma.maxFeldsherApplication.create({
    data: {
      maxUserId: user.id,
      name: sanitizeInput(data.name, 100),
      phone: sanitizeInput(data.phone, 20),
      experience: sanitizeInput(data.experience, 10),
      scheduleType: sanitizeInput(data.scheduleType, 50),
      resumeLink: sanitizeInput(data.resumeLink || '', 500),
    },
  });
}

async function saveQuestion(maxId: number, data: any) {
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) throw new Error('User not found');
  
  return prisma.maxQuestion.create({
    data: { 
      maxUserId: user.id, 
      name: sanitizeInput(data.name, 100), 
      phone: sanitizeInput(data.phone, 20), 
      question: sanitizeInput(data.question, MAX_QUESTION_LENGTH) 
    },
  });
}

// ============== NOTIFICATIONS ==============

async function sendNotification(type: string, data: any) {
  let message = '';
  
  if (type === 'waitlist') {
    message = `📋 Новая заявка в лист ожидания:
👤 Имя: ${escapeHtml(data.name)}
📞 Телефон: ${escapeHtml(data.phone)}
📍 Район: ${escapeHtml(data.district)}`;
  } else if (type === 'feldsher') {
    message = `👨‍⚕️ Новая анкета фельдшера:
👤 Имя: ${escapeHtml(data.name)}
📞 Телефон: ${escapeHtml(data.phone)}
⏳ Стаж: ${escapeHtml(data.experience)}
📅 График: ${escapeHtml(data.scheduleType)}
📎 Резюме: ${escapeHtml(data.resumeLink || 'Не указано')}`;
  } else if (type === 'question') {
    message = `❓ Новый вопрос:
👤 Имя: ${escapeHtml(data.name)}
📞 Телефон: ${escapeHtml(data.phone)}
💬 Вопрос: ${escapeHtml(data.question)}`;
  }
  
  if (ADMIN_ID && message) {
    try {
      await bot.api.sendMessage(ADMIN_ID, message);
    } catch (e) {
      log('ERROR', 'Failed to send notification', e);
    }
  }
}

// ============== VALIDATION ==============

function validatePhone(phone: string): boolean {
  const cleaned = phone.replace(/\s/g, '');
  return /^[\+]?[0-9][0-9\-\s]{9,15}$/.test(cleaned);
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return '+' + '7' + digits.slice(1);
  if (digits.startsWith('7') && digits.length === 11) return '+' + digits;
  if (digits.length === 10) return '+7' + digits;
  return phone;
}

// ============== MESSAGES ==============

const CONSENT_MESSAGE = `🔐 Перед началом использования бота подтвердите согласие с Политикой конфиденциальности и согласие на обработку персональных данных по ссылкам ниже:

📄 Политика конфиденциальности:
стр. 1: https://t.me/FeldsherRyadom/10
стр. 2: https://t.me/FeldsherRyadom/11

📝 Согласие на обработку персональных данных:
https://t.me/FeldsherRyadom/5

Напишите "согласен" или "согласна" для продолжения.`;

const WELCOME_MESSAGE = `👋 Здравствуйте! Я бот проекта «Фельдшеръ.Рядом».

Я помогу:
📋 записаться в лист ожидания открытия кабинета (/waitlist)
❓ задать вопрос о проекте (/question)
👨‍⚕️ оставить резюме фельдшеру (/feldsher)
❤️ поддержать проект (/podderzhka)
📄 получить текст доверенности (/doveren)`;

const DOVEREN_MESSAGE = `📄 ДОВЕРЕННОСТЬ

Я, (Фамилия, Имя, Отчество), паспортные данные доверителя полностью
доверяю (Фамилия, Имя, Отчество), паспортные данные доверенного лица полностью
сопровождать моего ребёнка Фамилия, Имя, Отчество ребёнка и дата рождения
в медицинский кабинет «Фельдшеръ.Рядом» (ООО «Фельдшер и компания»)
для получения доврачебной медицинской помощи (осмотр, инъекции, ЭКГ, справки и т.п. в рамках компетенции фельдшера).

Предоставляю право подписывать необходимые медицинские документы,
включая информированное добровольное согласие на медицинские вмешательства, получать результаты осмотров и справки.

Доверенность действительна по (ДАТА ДЕЙСТВИЯ ДОВЕРЕННОСТИ)
ПОДПИСЬ, РАСШИФРОВКА ПОДПИСИ
(ДАТА НАПИСАНИЯ ДОВЕРЕННОСТИ)`;

const PRIVACY_MESSAGE = `Политика конфиденциальности и согласие на обработку персональных данных по ссылкам ниже:

📄 Политика конфиденциальности:
стр. 1: https://t.me/FeldsherRyadom/10
стр. 2: https://t.me/FeldsherRyadom/11

📝 Согласие на обработку персональных данных:
https://t.me/FeldsherRyadom/5`;

const PODDERZHKA_MESSAGE = `Спасибо за желание помочь проекту «Фельдшеръ.Рядом»! ❤️

Перевод по ссылке:
https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

Если хотите отправить анонимно, то можете сделать перевод напрямую по номеру телефона:
📞 +7 (965) 843-78-18`;

// ============== HELPER TO GET USER ID ==============

function getUserId(ctx: any): number | null {
  const sender = ctx.sender || ctx.from || ctx.message?.sender;
  if (sender?.user_id) return sender.user_id;
  if (sender?.id) return sender.id;
  return null;
}

function getUserData(ctx: any): any {
  const sender = ctx.sender || ctx.from || ctx.message?.sender;
  return {
    username: sender?.username || '',
    firstName: sender?.first_name || sender?.name || '',
    lastName: sender?.last_name || '',
  };
}

// ============== BOT HANDLERS ==============

bot.on('bot_started', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  
  log('INFO', `User ${id} started bot (bot_started event)`);
  await getOrCreateUser(id, getUserData(ctx));
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  
  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE);
});

bot.command('start', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  
  log('INFO', `User ${id} used /start command`);
  await getOrCreateUser(id, getUserData(ctx));
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  
  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE);
});

bot.command('admin_logs', async (ctx) => {
  const id = getUserId(ctx);
  if (!id || !isAdmin(id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  securityLog('ADMIN_VIEW_LOGS', id);
  ctx.reply(`📊 Логи бота:\n📁 /app/data/logs/\n📄 bot.log\n🔒 security.log`);
});

bot.command('admin_stats', async (ctx) => {
  const id = getUserId(ctx);
  if (!id || !isAdmin(id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  securityLog('ADMIN_VIEW_STATS', id);
  try {
    const users = await prisma.maxUser.count();
    const waitlist = await prisma.maxWaitlistEntry.count();
    const feldshers = await prisma.maxFeldsherApplication.count();
    const questions = await prisma.maxQuestion.count();
    ctx.reply(`📊 Статистика:\n👥 Пользователей: ${users}\n📋 Лист ожидания: ${waitlist}\n👨‍⚕️ Фельдшеры: ${feldshers}\n❓ Вопросы: ${questions}`);
  } catch (e) {
    ctx.reply('Ошибка получения статистики.');
  }
});

bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_COMMAND', id);
  ctx.reply('Напишите ваше имя:');
});

bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_COMMAND', id);
  ctx.reply('Напишите ваше имя:');
});

bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_COMMAND', id);
  ctx.reply('Напишите ваше имя:');
});

bot.command('doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  securityLog('DOVEREN_COMMAND', id);
  ctx.reply(DOVEREN_MESSAGE);
});

bot.command('podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE);
  }
  securityLog('PODDERZHKA_COMMAND', id);
  ctx.reply(PODDERZHKA_MESSAGE);
});

bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  securityLog('PRIVACY_COMMAND', id);
  ctx.reply(PRIVACY_MESSAGE);
});

// ============== TEXT HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text;
  
  if (!id || !text) return;
  
  log('INFO', `Message from user ${id}: ${text}`);
  
  // Check for consent
  const consentKeywords = ['согласен', 'согласна', 'да', 'yes'];
  if (consentKeywords.some(k => text.toLowerCase().includes(k))) {
    if (!(await hasUserConsent(id))) {
      await getOrCreateUser(id, getUserData(ctx));
      await setUserConsent(id, true);
      securityLog('CONSENT_GRANTED', id);
      return ctx.reply('✅ Спасибо за согласие! Напишите /start для начала работы.');
    }
  }
  
  // Check for cancel
  if (text === '❌ Отменить' || text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
    await clearUserState(id);
    securityLog('FLOW_CANCELLED', id);
    return ctx.reply('❌ Отменено. Напишите /start для начала работы.');
  }
  
  const state = await getUserState(id);
  if (!state) {
    return ctx.reply('Напишите /start для начала работы.');
  }
  
  const sanitizedText = sanitizeInput(text, state.flowType === 'question' && state.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);
  const stateData = state.data;
  
  // Waitlist flow
  if (state.flowType === 'waitlist') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'waitlist', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'waitlist', 'district', stateData);
      return ctx.reply('Выберите район (напишите цифру):\n1. Индустриальный\n2. Ленинский\n3. Октябрьский\n4. Первомайский\n5. Устиновский');
    } else if (state.currentStep === 'district') {
      const districtMap: Record<string, string> = {
        '1': 'Индустриальный', '2': 'Ленинский', '3': 'Октябрьский', '4': 'Первомайский', '5': 'Устиновский'
      };
      const district = districtMap[sanitizedText] || sanitizedText;
      stateData.district = district;
      
      try {
        await saveWaitlistEntry(id, stateData);
        await sendNotification('waitlist', stateData);
        securityLog('WAITLIST_ENTRY_SAVED', id, { district });
        await clearUserState(id);
        return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Вы добавлены в лист ожидания.`);
      } catch (e) {
        log('ERROR', `Failed to save waitlist entry`, e);
        return ctx.reply('Ошибка сохранения. Попробуйте позже.');
      }
    }
    return;
  }
  
  // Feldsher flow
  if (state.flowType === 'feldsher') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'feldsher', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'feldsher', 'experience', stateData);
      return ctx.reply('Ваш стаж работы (лет):');
    } else if (state.currentStep === 'experience') {
      stateData.experience = sanitizedText;
      await setUserState(id, 'feldsher', 'schedule', stateData);
      return ctx.reply('Выберите график (напишите 1 или 2):\n1. 16 смен\n2. 12 смен');
    } else if (state.currentStep === 'schedule') {
      const scheduleMap: Record<string, string> = { '1': '16 смен', '2': '12 смен' };
      stateData.scheduleType = scheduleMap[sanitizedText] || sanitizedText;
      await setUserState(id, 'feldsher', 'resume', stateData);
      return ctx.reply('Ссылка на резюме или описание опыта (или напишите "нет"):');
    } else if (state.currentStep === 'resume') {
      stateData.resumeLink = sanitizedText === 'нет' ? '' : sanitizedText;
      try {
        await saveFeldsherApplication(id, stateData);
        await sendNotification('feldsher', stateData);
        securityLog('FELDSHER_APPLICATION_SAVED', id);
        await clearUserState(id);
        return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Ваша анкета принята.`);
      } catch (e) {
        log('ERROR', `Failed to save feldsher application`, e);
        return ctx.reply('Ошибка сохранения. Попробуйте позже.');
      }
    }
    return;
  }
  
  // Question flow
  if (state.flowType === 'question') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'question', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'question', 'question', stateData);
      return ctx.reply('Напишите ваш вопрос:');
    } else if (state.currentStep === 'question') {
      stateData.question = sanitizedText;
      try {
        await saveQuestion(id, stateData);
        await sendNotification('question', stateData);
        securityLog('QUESTION_SAVED', id);
        await clearUserState(id);
        return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Ваш вопрос принят.`);
      } catch (e) {
        log('ERROR', `Failed to save question`, e);
        return ctx.reply('Ошибка сохранения. Попробуйте позже.');
      }
    }
    return;
  }
});

bot.catch((err) => {
  log('ERROR', 'Bot error', err);
  console.error('Bot error:', err);
});

// ============== HTTP SERVER FOR AMVERA ==============

async function startHttpServer(port: number) {
  const server = Bun.serve({
    port: port,
    fetch(req) {
      const url = new URL(req.url);
      
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response(JSON.stringify({ 
          status: 'ok', 
          bot: 'FeldsherRyadomBot for MAX',
          time: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response('Not found', { status: 404 });
    },
  });
  
  log('INFO', `HTTP server started on port ${port}`);
  console.log(`🌐 HTTP server listening on port ${port}`);
  
  return server;
}

// ============== START ==============

async function main() {
  log('INFO', 'FeldsherRyadomBot for MAX starting...');
  console.log('🤖 FeldsherRyadomBot for MAX starting...');
  
  try {
    await prisma.$connect();
    log('INFO', 'Database connected');
    console.log('✅ Database connected');
  } catch (error) {
    log('ERROR', 'Database connection failed', error);
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
  
  // Start HTTP server for Amvera health checks
  await startHttpServer(BOT_CONFIG.port);
  
  // Set bot commands
  try {
    await bot.api.setMyCommands([
      { name: 'start', description: 'Начать работу с ботом' },
      { name: 'waitlist', description: 'Записаться в лист ожидания' },
      { name: 'question', description: 'Задать вопрос' },
      { name: 'feldsher', description: 'Отправить резюме фельдшера' },
      { name: 'doveren', description: 'Текст доверенности' },
      { name: 'podderzhka', description: 'Поддержать проект' },
      { name: 'privacy', description: 'Политика конфиденциальности' },
    ]);
    log('INFO', 'Bot commands set successfully');
    console.log('✅ Bot commands set');
  } catch (error) {
    log('WARN', 'Could not set bot commands', error);
    console.log('⚠️ Could not set bot commands');
  }
  
  // Start bot with polling
  log('INFO', 'Starting bot with polling...');
  console.log('🔄 Starting bot with polling...');
  
  bot.start();
  
  log('INFO', 'Bot started successfully');
  console.log('✅ Bot started successfully!');
}

main().catch((err) => {
  log('ERROR', 'Fatal error', err);
  console.error(err);
});

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
