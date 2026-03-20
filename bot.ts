#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 1.0
 */

import { Bot, Context, Markup } from '@maxhub/max-bot-api';
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
  channelLink: 'https://max.ru/FeldsherRyadom',
  supportLink: 'https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM',
  supportPhone: '+7 (965) 843-78-18',
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
https://t.me/FeldsherRyadom/5`;

const WELCOME_MESSAGE = `👋 Здравствуйте! Я бот проекта «Фельдшеръ.Рядом».

Я помогу:
📋 записаться в лист ожидания открытия кабинета,
❓ задать вопрос о проекте,
👨‍⚕️ оставить резюме фельдшеру,
❤️ поддержать проект.

Выберите, что вас интересует:`;

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

// ============== KEYBOARDS ==============

const getConsentKB = () => ({
  inline_keyboard: [
    [{ text: '✅ СОГЛАСЕН(-НА)', callback_data: 'consent_yes' }],
    [{ text: '❌ НЕ СОГЛАСЕН(-НА)', callback_data: 'consent_no' }]
  ]
});

const getMainKB = () => ({
  inline_keyboard: [
    [{ text: '📋 Пациенту – в лист ожидания', callback_data: 'action_waitlist' }],
    [{ text: '❓ Задать вопрос', callback_data: 'action_question' }],
    [{ text: '👨‍⚕️ Фельдшеру – отправить резюме', callback_data: 'action_feldsher' }],
    [{ text: '❤️ Поддержать проект', callback_data: 'action_podderzhka' }],
    [{ text: '📄 Текст доверенности', callback_data: 'action_doveren' }]
  ]
});

const getQuestionKB = () => ({
  inline_keyboard: [
    [{ text: '❓ Задать вопрос', callback_data: 'question_start' }],
    [{ text: '🗑️ Отозвать согласие', callback_data: 'revoke_consent' }]
  ]
});

const getDistrictKB = () => ({
  inline_keyboard: [
    [{ text: '1. Индустриальный', callback_data: 'district_1' }],
    [{ text: '2. Ленинский', callback_data: 'district_2' }],
    [{ text: '3. Октябрьский', callback_data: 'district_3' }],
    [{ text: '4. Первомайский', callback_data: 'district_4' }],
    [{ text: '5. Устиновский', callback_data: 'district_5' }],
    [{ text: '❌ Отменить', callback_data: 'cancel' }]
  ]
});

const getScheduleKB = () => ({
  inline_keyboard: [
    [{ text: 'Вариант 1 (16 смен)', callback_data: 'schedule_16' }],
    [{ text: 'Вариант 2 (12 смен)', callback_data: 'schedule_12' }],
    [{ text: '❌ Отменить', callback_data: 'cancel' }]
  ]
});

const getCancelKB = () => ({
  keyboard: [[{ text: '❌ Отменить' }]],
  resize_keyboard: true
});

const noKB = () => ({ remove_keyboard: true });

// ============== BOT HANDLERS ==============

bot.command('start', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  log('INFO', `User ${id} started bot`);
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE, getMainKB());
});

// Admin commands
bot.command('admin_logs', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id || !isAdmin(id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  
  securityLog('ADMIN_VIEW_LOGS', id);
  ctx.reply(`📊 Логи бота:
📁 Расположение: /app/data/logs/
📄 Основной лог: bot.log
🔒 Безопасность: security.log`);
});

bot.command('admin_stats', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id || !isAdmin(id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
  
  securityLog('ADMIN_VIEW_STATS', id);
  
  try {
    const users = await prisma.maxUser.count();
    const waitlist = await prisma.maxWaitlistEntry.count();
    const feldshers = await prisma.maxFeldsherApplication.count();
    const questions = await prisma.maxQuestion.count();
    
    ctx.reply(`📊 Статистика бота:

👥 Пользователей: ${users}
📋 Заявок в листе ожидания: ${waitlist}
👨‍⚕️ Анкет фельдшеров: ${feldshers}
❓ Вопросов: ${questions}`);
  } catch (e) {
    ctx.reply('Ошибка получения статистики.');
  }
});

// Menu commands
bot.command('waitlist', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_COMMAND', id);
  ctx.reply('Напишите имя:', getCancelKB());
});

bot.command('question', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  ctx.reply('Выберите:', getQuestionKB());
});

bot.command('feldsher', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_COMMAND', id);
  ctx.reply('Как вас зовут?', getCancelKB());
});

bot.command('doveren', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  securityLog('DOVEREN_COMMAND', id);
  ctx.reply(DOVEREN_MESSAGE);
});

bot.command('podderzhka', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKB());
  }
  
  securityLog('PODDERZHKA_COMMAND', id);
  ctx.reply(PODDERZHKA_MESSAGE);
});

bot.command('privacy', async (ctx) => {
  const id = ctx.from?.user_id;
  if (!id) return;
  
  await getOrCreateUser(id, ctx.from);
  securityLog('PRIVACY_COMMAND', id);
  ctx.reply(PRIVACY_MESSAGE);
});

// ============== CALLBACK HANDLERS ==============

bot.on('callback_query', async (ctx) => {
  const id = ctx.from?.user_id;
  const data = ctx.callbackQuery?.data;
  if (!id || !data) return;
  
  // Consent handlers
  if (data === 'consent_yes') {
    await setUserConsent(id, true);
    securityLog('CONSENT_GRANTED', id);
    ctx.editMessageText('✅ Спасибо! Отправьте /start');
    return;
  }
  
  if (data === 'consent_no') {
    securityLog('CONSENT_DENIED', id);
    ctx.editMessageText('❌ Без согласия бот недоступен. /start');
    return;
  }
  
  if (data === 'revoke_consent') {
    await deleteAllUserData(id);
    securityLog('DATA_DELETED', id);
    ctx.editMessageText('🗑️ Данные удалены. /start');
    return;
  }
  
  if (data === 'cancel') {
    await clearUserState(id);
    securityLog('FLOW_CANCELLED', id);
    ctx.reply('❌ Отменено', noKB());
    ctx.reply(WELCOME_MESSAGE, getMainKB());
    return;
  }
  
  // Check consent for other actions
  if (!(await hasUserConsent(id))) {
    ctx.reply(CONSENT_MESSAGE, getConsentKB());
    return;
  }
  
  // Action handlers
  if (data === 'action_waitlist') {
    await setUserState(id, 'waitlist', 'name', {});
    securityLog('ACTION_STARTED', id, { action: 'waitlist' });
    ctx.reply('Напишите имя:', getCancelKB());
    return;
  }
  
  if (data === 'action_question') {
    ctx.reply('Выберите:', getQuestionKB());
    return;
  }
  
  if (data === 'action_feldsher') {
    await setUserState(id, 'feldsher', 'name', {});
    securityLog('ACTION_STARTED', id, { action: 'feldsher' });
    ctx.reply('Как вас зовут?', getCancelKB());
    return;
  }
  
  if (data === 'action_podderzhka') {
    ctx.reply(PODDERZHKA_MESSAGE);
    return;
  }
  
  if (data === 'action_doveren') {
    ctx.reply(DOVEREN_MESSAGE);
    return;
  }
  
  if (data === 'question_start') {
    await setUserState(id, 'question', 'name', {});
    securityLog('QUESTION_FLOW_STARTED', id);
    ctx.reply('Напишите имя:', getCancelKB());
    return;
  }
  
  // District selection
  if (data.startsWith('district_')) {
    const districtId = data.replace('district_', '');
    const state = await getUserState(id);
    
    if (!state || state.flowType !== 'waitlist') {
      ctx.reply('Ошибка. /start');
      return;
    }
    
    const district = BOT_CONFIG.districts.find(d => d.id === districtId);
    if (!district) return;
    
    const stateData = state.data;
    stateData.district = district.name;
    
    try {
      await saveWaitlistEntry(id, stateData);
      await sendNotification('waitlist', stateData);
      securityLog('WAITLIST_ENTRY_SAVED', id, { district: district.name });
      ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Добавлены в лист ожидания.`, noKB());
    } catch (e) {
      log('ERROR', `Failed to save waitlist entry for user ${id}`, e);
      ctx.reply('Ошибка сохранения.');
    }
    await clearUserState(id);
    return;
  }
  
  // Schedule selection
  if (data.startsWith('schedule_')) {
    const scheduleId = data.replace('schedule_', '');
    const state = await getUserState(id);
    
    if (!state || state.flowType !== 'feldsher') return;
    
    const stateData = state.data;
    stateData.scheduleType = BOT_CONFIG.scheduleOptions[`schedule_${scheduleId}`];
    await setUserState(id, 'feldsher', 'resume', stateData);
    ctx.reply('Резюме или опыт:', getCancelKB());
    return;
  }
});

// ============== TEXT HANDLER ==============

bot.on('message', async (ctx) => {
  const id = ctx.from?.user_id;
  const text = ctx.message?.text;
  
  if (!id || !text) return;
  
  if (text === '❌ Отменить') {
    await clearUserState(id);
    securityLog('FLOW_CANCELLED', id);
    ctx.reply('❌ Отменено', noKB());
    ctx.reply(WELCOME_MESSAGE, getMainKB());
    return;
  }
  
  const state = await getUserState(id);
  if (!state) {
    return ctx.reply('Используйте меню. /start', getMainKB());
  }
  
  const sanitizedText = sanitizeInput(text, state.flowType === 'question' && state.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);
  
  if (text.length > sanitizedText.length) {
    ctx.reply(`⚠️ Сообщение слишком длинное. Сохранено ${sanitizedText.length} символов из ${text.length}.`);
  }
  
  const stateData = state.data;
  
  // Waitlist flow
  if (state.flowType === 'waitlist') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'waitlist', 'phone', stateData);
      ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх)', getCancelKB());
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:', getCancelKB());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'waitlist', 'district', stateData);
      ctx.reply('Район:', getDistrictKB());
    }
    return;
  }
  
  // Feldsher flow
  if (state.flowType === 'feldsher') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'feldsher', 'phone', stateData);
      ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх)', getCancelKB());
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:', getCancelKB());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'feldsher', 'experience', stateData);
      ctx.reply('Стаж (лет):', getCancelKB());
    } else if (state.currentStep === 'experience') {
      stateData.experience = sanitizedText;
      await setUserState(id, 'feldsher', 'schedule', stateData);
      ctx.reply('График:\n1️⃣ 16 смен\n2️⃣ 12 смен', getScheduleKB());
    } else if (state.currentStep === 'resume') {
      stateData.resumeLink = sanitizedText;
      try {
        await saveFeldsherApplication(id, stateData);
        await sendNotification('feldsher', stateData);
        securityLog('FELDSHER_APPLICATION_SAVED', id);
        ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}!`, noKB());
      } catch (e) {
        log('ERROR', `Failed to save feldsher application for user ${id}`, e);
        ctx.reply('Ошибка.');
      }
      await clearUserState(id);
    }
    return;
  }
  
  // Question flow
  if (state.flowType === 'question') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'question', 'phone', stateData);
      ctx.reply('Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх)', getCancelKB());
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:', getCancelKB());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'question', 'question', stateData);
      ctx.reply('Вопрос:', getCancelKB());
    } else if (state.currentStep === 'question') {
      stateData.question = sanitizedText;
      try {
        await saveQuestion(id, stateData);
        await sendNotification('question', stateData);
        securityLog('QUESTION_SAVED', id);
        ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}!`, noKB());
      } catch (e) {
        log('ERROR', `Failed to save question for user ${id}`, e);
        ctx.reply('Ошибка.');
      }
      await clearUserState(id);
    }
    return;
  }
});

bot.catch((err) => {
  log('ERROR', 'Bot error', err);
  console.error('Bot error:', err);
});

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
  
  log('INFO', 'Starting bot...');
  console.log('🔄 Starting bot...');
  
  bot.launch();
  
  log('INFO', 'Bot started successfully');
  console.log('✅ Bot started successfully!');
}

main().catch((err) => {
  log('ERROR', 'Fatal error', err);
  console.error(err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
