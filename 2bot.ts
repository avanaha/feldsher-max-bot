#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 2.0 - Webhook mode for Amvera HTTPS
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
  domain: process.env.AMVERA_DOMAIN || 'feldsher-max-bot-nnp.amvera.io',
  districts: [
    { id: '1', name: 'Индустриальный' },
    { id: '2', name: 'Ленинский' },
    { id: '3', name: 'Октябрьский' },
    { id: '4', name: 'Первомайский' },
    { id: '5', name: 'Устиновский' },
  ],
};

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
const ADMIN_ID = BOT_CONFIG.adminId;

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

// ============== MAX API CLIENT ==============
const MAX_API_BASE = 'https://api.max.ru';

async function maxApi(method: string, path: string, body?: any) {
  const url = `${MAX_API_BASE}${path}?access_token=${BOT_CONFIG.token}`;

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`MAX API error: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

// ============== WEBHOOK REGISTRATION ==============
async function registerWebhook() {
  const webhookUrl = `https://${BOT_CONFIG.domain}${BOT_CONFIG.webhookPath}`;

  log('INFO', `Registering webhook: ${webhookUrl}`);

  try {
    // First, get current subscriptions
    const subs = await maxApi('GET', '/subscriptions');
    log('INFO', 'Current subscriptions', subs);

    // Check if already registered
    if (subs.subscriptions && subs.subscriptions.some((s: any) => s.url === webhookUrl)) {
      log('INFO', 'Webhook already registered');
      return true;
    }

    // Register new webhook
    const result = await maxApi('POST', '/subscriptions', {
      url: webhookUrl,
      update_types: [
        'message_created',
        'message_callback',
        'bot_started',
        'bot_added',
        'chat_created',
      ],
    });

    log('INFO', 'Webhook registered successfully', result);
    return true;
  } catch (error) {
    log('ERROR', 'Failed to register webhook', error);
    return false;
  }
}

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
      await maxApi('POST', '/messages', {
        user_id: ADMIN_ID,
        body: {
          text: message,
        },
      });
    } catch (e) {
      log('ERROR', 'Failed to send notification', e);
    }
  }
}

// ============== SENDING MESSAGES ==============

async function sendMessage(userId: number, text: string) {
  try {
    await maxApi('POST', '/messages', {
      user_id: userId,
      body: {
        text: text,
      },
    });
  } catch (e) {
    log('ERROR', `Failed to send message to ${userId}`, e);
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

// ============== UPDATE HANDLERS ==============

async function handleBotStarted(update: any) {
  const userId = update.user?.user_id;
  if (!userId) return;

  log('INFO', `Bot started by user ${userId}`);

  await getOrCreateUser(userId, {
    username: update.user?.username || '',
    firstName: update.user?.first_name || update.user?.name || '',
    lastName: update.user?.last_name || '',
  });

  if (!(await hasUserConsent(userId))) {
    await sendMessage(userId, CONSENT_MESSAGE);
    return;
  }

  await clearUserState(userId);
  await sendMessage(userId, WELCOME_MESSAGE);
}

async function handleMessageCreated(update: any) {
  const userId = update.message?.sender?.user_id;
  const text = update.message?.body?.text;

  if (!userId || !text) return;

  log('INFO', `Message from user ${userId}: ${text}`);

  // Check for consent
  const consentKeywords = ['согласен', 'согласна', 'да', 'yes'];
  if (consentKeywords.some(k => text.toLowerCase().includes(k))) {
    if (!(await hasUserConsent(userId))) {
      await getOrCreateUser(userId, {
        username: update.message?.sender?.username || '',
        firstName: update.message?.sender?.first_name || update.message?.sender?.name || '',
        lastName: update.message?.sender?.last_name || '',
      });
      await setUserConsent(userId, true);
      securityLog('CONSENT_GRANTED', userId);
      await sendMessage(userId, '✅ Спасибо за согласие! Напишите /start для начала работы.');
      return;
    }
  }

  // Check for commands
  if (text.startsWith('/')) {
    await handleCommand(userId, text, update);
    return;
  }

  // Check for cancel
  if (text === '❌ Отменить' || text.toLowerCase() === 'отмена' || text.toLowerCase() === 'cancel') {
    await clearUserState(userId);
    securityLog('FLOW_CANCELLED', userId);
    await sendMessage(userId, '❌ Отменено. Напишите /start для начала работы.');
    return;
  }

  const state = await getUserState(userId);
  if (!state) {
    await sendMessage(userId, 'Напишите /start для начала работы.');
    return;
  }

  const sanitizedText = sanitizeInput(text, state.flowType === 'question' && state.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);
  const stateData = state.data;

  // Waitlist flow
  if (state.flowType === 'waitlist') {
    await handleWaitlistFlow(userId, state.currentStep, stateData, sanitizedText);
    return;
  }

  // Feldsher flow
  if (state.flowType === 'feldsher') {
    await handleFeldsherFlow(userId, state.currentStep, stateData, sanitizedText);
    return;
  }

  // Question flow
  if (state.flowType === 'question') {
    await handleQuestionFlow(userId, state.currentStep, stateData, sanitizedText);
    return;
  }
}

async function handleCommand(userId: number, text: string, update: any) {
  const command = text.split(' ')[0].toLowerCase();

  await getOrCreateUser(userId, {
    username: update.message?.sender?.username || '',
    firstName: update.message?.sender?.first_name || update.message?.sender?.name || '',
    lastName: update.message?.sender?.last_name || '',
  });

  switch (command) {
    case '/start':
      log('INFO', `User ${userId} used /start command`);
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      await clearUserState(userId);
      await sendMessage(userId, WELCOME_MESSAGE);
      break;

    case '/waitlist':
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      await setUserState(userId, 'waitlist', 'name', {});
      securityLog('WAITLIST_COMMAND', userId);
      await sendMessage(userId, 'Напишите ваше имя:');
      break;

    case '/question':
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      await setUserState(userId, 'question', 'name', {});
      securityLog('QUESTION_COMMAND', userId);
      await sendMessage(userId, 'Напишите ваше имя:');
      break;

    case '/feldsher':
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      await setUserState(userId, 'feldsher', 'name', {});
      securityLog('FELDSHER_COMMAND', userId);
      await sendMessage(userId, 'Напишите ваше имя:');
      break;

    case '/doveren':
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      securityLog('DOVEREN_COMMAND', userId);
      await sendMessage(userId, DOVEREN_MESSAGE);
      break;

    case '/podderzhka':
      if (!(await hasUserConsent(userId))) {
        await sendMessage(userId, CONSENT_MESSAGE);
        return;
      }
      securityLog('PODDERZHKA_COMMAND', userId);
      await sendMessage(userId, PODDERZHKA_MESSAGE);
      break;

    case '/privacy':
      securityLog('PRIVACY_COMMAND', userId);
      await sendMessage(userId, PRIVACY_MESSAGE);
      break;

    case '/admin_logs':
      if (!isAdmin(userId)) {
        await sendMessage(userId, '⛔ Доступ запрещён.');
        return;
      }
      securityLog('ADMIN_VIEW_LOGS', userId);
      await sendMessage(userId, `📊 Логи бота:\n📁 /app/data/logs/\n📄 bot.log\n🔒 security.log`);
      break;

    case '/admin_stats':
      if (!isAdmin(userId)) {
        await sendMessage(userId, '⛔ Доступ запрещён.');
        return;
      }
      securityLog('ADMIN_VIEW_STATS', userId);
      try {
        const users = await prisma.maxUser.count();
        const waitlist = await prisma.maxWaitlistEntry.count();
        const feldshers = await prisma.maxFeldsherApplication.count();
        const questions = await prisma.maxQuestion.count();
        await sendMessage(userId, `📊 Статистика:\n👥 Пользователей: ${users}\n📋 Лист ожидания: ${waitlist}\n👨‍⚕️ Фельдшеры: ${feldshers}\n❓ Вопросы: ${questions}`);
      } catch (e) {
        await sendMessage(userId, 'Ошибка получения статистики.');
      }
      break;

    default:
      await sendMessage(userId, 'Неизвестная команда. Напишите /start для начала работы.');
  }
}

async function handleWaitlistFlow(userId: number, step: string, data: any, text: string) {
  if (step === 'name') {
    data.name = text;
    await setUserState(userId, 'waitlist', 'phone', data);
    await sendMessage(userId, 'Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
  } else if (step === 'phone') {
    if (!validatePhone(text)) {
      await sendMessage(userId, 'Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      return;
    }
    data.phone = formatPhone(text);
    await setUserState(userId, 'waitlist', 'district', data);
    await sendMessage(userId, 'Выберите район (напишите цифру):\n1. Индустриальный\n2. Ленинский\n3. Октябрьский\n4. Первомайский\n5. Устиновский');
  } else if (step === 'district') {
    const districtMap: Record<string, string> = {
      '1': 'Индустриальный', '2': 'Ленинский', '3': 'Октябрьский', '4': 'Первомайский', '5': 'Устиновский'
    };
    const district = districtMap[text] || text;
    data.district = district;

    try {
      await saveWaitlistEntry(userId, data);
      await sendNotification('waitlist', data);
      securityLog('WAITLIST_ENTRY_SAVED', userId, { district });
      await clearUserState(userId);
      await sendMessage(userId, `✅ Спасибо, ${escapeHtml(data.name)}! Вы добавлены в лист ожидания.`);
    } catch (e) {
      log('ERROR', `Failed to save waitlist entry`, e);
      await sendMessage(userId, 'Ошибка сохранения. Попробуйте позже.');
    }
  }
}

async function handleFeldsherFlow(userId: number, step: string, data: any, text: string) {
  if (step === 'name') {
    data.name = text;
    await setUserState(userId, 'feldsher', 'phone', data);
    await sendMessage(userId, 'Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
  } else if (step === 'phone') {
    if (!validatePhone(text)) {
      await sendMessage(userId, 'Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      return;
    }
    data.phone = formatPhone(text);
    await setUserState(userId, 'feldsher', 'experience', data);
    await sendMessage(userId, 'Ваш стаж работы (лет):');
  } else if (step === 'experience') {
    data.experience = text;
    await setUserState(userId, 'feldsher', 'schedule', data);
    await sendMessage(userId, 'Выберите график (напишите 1 или 2):\n1. 16 смен\n2. 12 смен');
  } else if (step === 'schedule') {
    const scheduleMap: Record<string, string> = { '1': '16 смен', '2': '12 смен' };
    data.scheduleType = scheduleMap[text] || text;
    await setUserState(userId, 'feldsher', 'resume', data);
    await sendMessage(userId, 'Ссылка на резюме или описание опыта (или напишите "нет"):');
  } else if (step === 'resume') {
    data.resumeLink = text === 'нет' ? '' : text;
    try {
      await saveFeldsherApplication(userId, data);
      await sendNotification('feldsher', data);
      securityLog('FELDSHER_APPLICATION_SAVED', userId);
      await clearUserState(userId);
      await sendMessage(userId, `✅ Спасибо, ${escapeHtml(data.name)}! Ваша анкета принята.`);
    } catch (e) {
      log('ERROR', `Failed to save feldsher application`, e);
      await sendMessage(userId, 'Ошибка сохранения. Попробуйте позже.');
    }
  }
}

async function handleQuestionFlow(userId: number, step: string, data: any, text: string) {
  if (step === 'name') {
    data.name = text;
    await setUserState(userId, 'question', 'phone', data);
    await sendMessage(userId, 'Ваш номер телефона (в формате: +7-9хх-ххх-хх-хх):');
  } else if (step === 'phone') {
    if (!validatePhone(text)) {
      await sendMessage(userId, 'Неверный формат. Введите номер в формате +7-9хх-ххх-хх-хх:');
      return;
    }
    data.phone = formatPhone(text);
    await setUserState(userId, 'question', 'question', data);
    await sendMessage(userId, 'Напишите ваш вопрос:');
  } else if (step === 'question') {
    data.question = text;
    try {
      await saveQuestion(userId, data);
      await sendNotification('question', data);
      securityLog('QUESTION_SAVED', userId);
      await clearUserState(userId);
      await sendMessage(userId, `✅ Спасибо, ${escapeHtml(data.name)}! Ваш вопрос принят.`);
    } catch (e) {
      log('ERROR', `Failed to save question`, e);
      await sendMessage(userId, 'Ошибка сохранения. Попробуйте позже.');
    }
  }
}

// ============== WEBHOOK HANDLER ==============

async function handleWebhook(update: any) {
  log('INFO', 'Received webhook update', update);

  try {
    switch (update.update_type) {
      case 'bot_started':
        await handleBotStarted(update);
        break;

      case 'message_created':
        await handleMessageCreated(update);
        break;

      case 'message_callback':
        log('INFO', 'Received callback', update);
        break;

      default:
        log('INFO', `Unhandled update type: ${update.update_type}`);
    }
  } catch (error) {
    log('ERROR', 'Error handling update', error);
  }
}

// ============== SET BOT COMMANDS ==============

async function setBotCommands() {
  try {
    await maxApi('PATCH', '/me', {
      commands: [
        { name: 'start', description: 'Начать работу с ботом' },
        { name: 'waitlist', description: 'Записаться в лист ожидания' },
        { name: 'question', description: 'Задать вопрос' },
        { name: 'feldsher', description: 'Отправить резюме фельдшера' },
        { name: 'doveren', description: 'Текст доверенности' },
        { name: 'podderzhka', description: 'Поддержать проект' },
        { name: 'privacy', description: 'Политика конфиденциальности' },
      ],
    });
    log('INFO', 'Bot commands set successfully');
  } catch (error) {
    log('WARN', 'Could not set bot commands', error);
  }
}

// ============== HTTP SERVER ==============

async function startServer() {
  const server = Bun.serve({
    port: BOT_CONFIG.port,

    async fetch(req) {
      const url = new URL(req.url);

      // Health check endpoint
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          bot: 'FeldsherRyadomBot for MAX',
          mode: 'webhook',
          time: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Webhook endpoint
      if (url.pathname === BOT_CONFIG.webhookPath && req.method === 'POST') {
        try {
          const update = await req.json();
          await handleWebhook(update);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (error) {
          log('ERROR', 'Webhook processing error', error);
          return new Response(JSON.stringify({ ok: false, error: 'Processing error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });

  log('INFO', `HTTP server started on port ${BOT_CONFIG.port}`);
  console.log(`🌐 HTTP server listening on port ${BOT_CONFIG.port}`);
  console.log(`🔗 Webhook URL: https://${BOT_CONFIG.domain}${BOT_CONFIG.webhookPath}`);

  return server;
}

// ============== MAIN ==============

async function main() {
  log('INFO', 'FeldsherRyadomBot for MAX starting (Webhook mode)...');
  console.log('🤖 FeldsherRyadomBot for MAX starting (Webhook mode)...');

  if (!BOT_CONFIG.token) {
    log('ERROR', 'MAX_BOT_TOKEN not set!');
    process.exit(1);
  }

  try {
    await prisma.$connect();
    log('INFO', 'Database connected');
    console.log('✅ Database connected');
  } catch (error) {
    log('ERROR', 'Database connection failed', error);
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }

  // Start HTTP server
  await startServer();

  // Set bot commands
  await setBotCommands();

  // Register webhook
  const webhookRegistered = await registerWebhook();
  if (webhookRegistered) {
    console.log('✅ Webhook registered successfully');
  } else {
    console.log('⚠️ Webhook registration failed, bot may not receive updates');
  }

  log('INFO', 'Bot started successfully');
  console.log('✅ Bot started successfully!');
}

main().catch((err) => {
  log('ERROR', 'Fatal error', err);
  console.error(err);
});

process.once('SIGINT', () => {
  log('INFO', 'Shutting down (SIGINT)');
  process.exit(0);
});

process.once('SIGTERM', () => {
  log('INFO', 'Shutting down (SIGTERM)');
  process.exit(0);
});
