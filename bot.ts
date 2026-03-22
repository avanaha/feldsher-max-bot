#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 11.0
 * 
 * Исправления в v11.0:
 * - ИСПРАВЛЕНО: getUserId() использует ctx.user (правильный способ для MAX API)
 * - ИСПРАВЛЕНО: callbackData получается через ctx.callback?.payload
 * - ИСПРАВЛЕНО: Тексты анкет согласно ТЗ
 * - ИСПРАВЛЕНО: Кнопки графика: "16 смен (основной фельдшер)" и "12 смен (воскресный фельдшер)"
 * - ДОБАВЛЕНО: Rate Limiting (мягкий, без блокировки активных анкет)
 * - ДОБАВЛЕНО: Валидация URL в поле "резюме"
 * - ДОБАВЛЕНО: Ротация логов (хранение 7 дней)
 * - ДОБАВЛЕНО: Шифрование номеров телефонов в БД
 * - ДОБАВЛЕНО: Уведомления админу о подозрительной активности
 * - ДОБАВЛЕНО: Регулярные бэкапы БД
 * - ДОБАВЛЕНО: Обработка chat.denied с очисткой данных
 * - УБРАНО: adminId и channelId из /health endpoint
 * 
 * Repository: https://github.com/avanaha/feldsher-max-bot
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ============== CONFIG ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '162749713');
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || '-72328888338961';
const BACKUP_EMAIL = 'feldland@yandex.ru';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'feldsher-encryption-key-2024';

// ============== LOGGING WITH ROTATION ==============
const LOG_DIR = '/app/data/logs';
const LOG_FILE = join(LOG_DIR, 'bot.log');
const SECURITY_LOG_FILE = join(LOG_DIR, 'security.log');
const LOG_RETENTION_DAYS = 7;

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// Ротация логов - удаление файлов старше 7 дней
function rotateLogs() {
  try {
    const files = readdirSync(LOG_DIR);
    const now = Date.now();
    const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    
    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      try {
        const stats = require('fs').statSync(filePath);
        if (now - stats.mtimeMs > maxAge) {
          unlinkSync(filePath);
          console.log(`Rotated log file: ${file}`);
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Log rotation error:', e);
  }
}

// Запускаем ротацию при старте и каждый день
rotateLogs();
setInterval(rotateLogs, 24 * 60 * 60 * 1000);

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
    if (parts.length !== 2) return encryptedText; // Не зашифровано
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedText; // Если не удалось расшифровать
  }
}

// ============== RATE LIMITING (МЯГКИЙ) ==============
const rateLimitMap = new Map<number, { count: number; lastRequest: number; warned: boolean }>();
const RATE_LIMIT_WINDOW = 60000; // 1 минута
const RATE_LIMIT_MAX = 30; // 30 запросов в минуту
const RATE_LIMIT_WARN = 20; // Предупреждение после 20 запросов

// Пользователи в активной анкете - exempt от rate limiting
const activeQuestionnaires = new Set<number>();

function checkRateLimit(userId: number): { allowed: boolean; warn: boolean; remaining: number } {
  // Пропускаем пользователей в активной анкете
  if (activeQuestionnaires.has(userId)) {
    return { allowed: true, warn: false, remaining: RATE_LIMIT_MAX };
  }
  
  const now = Date.now();
  const record = rateLimitMap.get(userId);
  
  if (!record || now - record.lastRequest > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(userId, { count: 1, lastRequest: now, warned: false });
    return { allowed: true, warn: false, remaining: RATE_LIMIT_MAX - 1 };
  }
  
  if (record.count >= RATE_LIMIT_MAX) {
    return { allowed: false, warn: false, remaining: 0 };
  }
  
  record.count++;
  record.lastRequest = now;
  
  const shouldWarn = record.count >= RATE_LIMIT_WARN && !record.warned;
  if (shouldWarn) {
    record.warned = true;
  }
  
  return { allowed: true, warn: shouldWarn, remaining: RATE_LIMIT_MAX - record.count };
}

// Очистка старых записей rate limit каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [userId, record] of rateLimitMap.entries()) {
    if (now - record.lastRequest > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(userId);
    }
  }
}, 5 * 60 * 1000);

// ============== VALIDATION ==============
const MAX_INPUT_LENGTH = 500;
const MAX_QUESTION_LENGTH = 1000;

function sanitizeInput(text: string, maxLength: number = MAX_INPUT_LENGTH): string {
  if (!text) return '';
  let sanitized = text.trim().substring(0, maxLength);
  sanitized = sanitized.replace(/<script|javascript:|on\w+=/gi, '');
  return sanitized;
}

function validateUrl(text: string): { valid: boolean; isUrl: boolean; value: string } {
  if (!text) return { valid: true, isUrl: false, value: '' };
  
  const trimmed = text.trim().toLowerCase();
  
  // Если "нет" или похожее - разрешаем как текст
  if (trimmed === 'нет' || trimmed === 'нет резюме' || trimmed === '-') {
    return { valid: true, isUrl: false, value: 'Резюме не предоставлено' };
  }
  
  // Проверяем URL
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    const allowedDomains = ['.ru', '.com', '.org', '.net', '.io', '.pdf', 'drive.google', 'docs.google', 'yandex', 'mail.ru', 'vk.com', 'hh.ru', 'linkedin', 'github'];
    const isAllowed = allowedDomains.some(d => url.hostname.includes(d) || url.pathname.includes(d));
    
    if (isAllowed || url.protocol === 'https:') {
      return { valid: true, isUrl: true, value: url.href };
    }
    
    return { valid: true, isUrl: false, value: sanitizeInput(text, 500) };
  } catch (e) {
    // Не URL - принимаем как текст описания опыта
    return { valid: true, isUrl: false, value: sanitizeInput(text, 500) };
  }
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
  const digits = text.replace(/\D/g, '');
  const years = parseInt(digits);
  return !isNaN(years) && years >= 0 && years <= 50;
}

// ============== DATABASE ==============
const dataDir = '/app/data';
if (!existsSync(dataDir)) {
  try {
    mkdirSync(dataDir, { recursive: true });
    log('INFO', 'Created data directory');
  } catch (e) {
    log('ERROR', 'Could not create data directory', e);
  }
}

const prisma = new PrismaClient({ log: ['error'] });

const BOT_CONFIG = {
  token: process.env.MAX_BOT_TOKEN || '',
  adminId: ADMIN_ID,
  channelId: CHANNEL_ID,
  port: parseInt(process.env.PORT || '8080'),
  feldsherChannelLink: 'https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8',
  patientChannelLink: 'https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8',
  planetaLink: 'https://planeta.ru/campaigns/feldsherryadom',
  sberLink: 'https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM',
  supportPhone: '+7 (965) 843-78-18',
  privacyLink: 'https://feldsher-land.ru/privacy',
  vkPatientLink: 'https://vk.com/feldsherryadom',
  vkFeldsherLink: 'https://vk.com/feldsherizh',
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
  } catch (e) {
    log('ERROR', 'hasUserConsent error', e);
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
  
  // Добавляем в активные анкеты
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
  // Убираем из активных анкет
  activeQuestionnaires.delete(maxId);
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
      phone: encrypt(data.phone), // Шифруем телефон
      district: sanitizeInput(data.district, 50),
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
      phone: encrypt(data.phone), // Шифруем телефон
      experience: sanitizeInput(data.experience, 10),
      scheduleType: sanitizeInput(data.scheduleType, 50),
      resumeLink: sanitizeInput(data.resumeLink, 500) || null,
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
      phone: encrypt(data.phone), // Шифруем телефон
      question: sanitizeInput(data.question, MAX_QUESTION_LENGTH),
    },
  });
}

// ============== KEYBOARDS ==============

const ConsentKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Согласен', 'consent_yes')],
  [Keyboard.button.callback('❌ Не согласен', 'consent_no')],
]);

const MainKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 Пациентам', 'menu_patient')],
  [Keyboard.button.callback('👨‍⚕️ Фельдшерам', 'menu_feldsher')],
  [Keyboard.button.callback('❓ Задать вопрос', 'menu_question')],
  [Keyboard.button.callback('📖 О проекте', 'menu_about')],
]);

const PatientKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 Хочу в лист ожидания', 'patient_waitlist')],
  [Keyboard.button.callback('📦 Заказать справки/выписки', 'patient_order')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const FeldsherKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📝 Заполнить анкету', 'feldsher_apply')],
  [Keyboard.button.callback('📖 О проекте', 'feldsher_about')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const QuestionKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✍️ Задать вопрос', 'question_ask')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const CancelKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❌ Отмена', 'cancel_flow')],
]);

const BackKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🔙 Назад', 'main_menu')],
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
  [Keyboard.button.callback('✅ Да, удалить мои данные', 'revoke_confirm')],
  [Keyboard.button.callback('❌ Отмена', 'main_menu')],
]);

const PrivacyKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const ChannelsKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('👥 Пациентам', 'channel_patient')],
  [Keyboard.button.callback('👨‍⚕️ Фельдшерам', 'channel_feldsher')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const PodderzhkaKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('💳 Сбербанк', 'podderzhka_sber')],
  [Keyboard.button.callback('🌍 Planeta.ru', 'podderzhka_planeta')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

// ============== MESSAGES ==============

const CONSENT_MESSAGE = `🔒 **Согласие на обработку персональных данных**

Нажимая кнопку «Согласен», вы подтверждаете свое согласие на обработку персональных данных в соответствии с Федеральным законом от 27.07.2006 № 152-ФЗ «О персональных данных».

**Обрабатываемые данные:**
• ФИО
• Номер телефона
• Район проживания (для пациентов)
• Информация о стаже работы (для фельдшеров)

**Цели обработки:**
• Запись в лист ожидания на вызов фельдшера
• Ответы на ваши вопросы
• Рассмотрение анкет фельдшеров

**Срок хранения:** до момента отзыва согласия

Политика конфиденциальности: ${BOT_CONFIG.privacyLink}`;

const WELCOME_MESSAGE = `👋 Добро пожаловать в «Фельдшеръ.Рядом»!

Мы — служба вызова фельдшера на дом для жителей Ижевска.

**Выберите раздел:**`;

const PATIENT_MENU_MESSAGE = `📋 **Меню для пациентов**

Выберите действие:`;

const FELDSHER_MENU_MESSAGE = `👨‍⚕️ **Меню для фельдшеров**

Выберите действие:`;

const QUESTION_MENU_MESSAGE = `❓ **Задать вопрос**

У вас есть вопрос? Нажмите кнопку ниже, чтобы задать его.`;

const ABOUT_MESSAGE = `📖 **О проекте «Фельдшеръ.Рядом»**

Мы — служба вызова фельдшера на дом для жителей Ижевска.

**Наши услуги:**
• Вызов фельдшера на дом
• Оформление справок и выписок
• Консультации по здоровью

**Контакты:**
📞 ${BOT_CONFIG.supportPhone}
🌐 ${BOT_CONFIG.vkPatientLink}`;

const ORDER_MESSAGE = `📦 **Заказ справок/выписок**

Для заказа справок и выписок обратитесь к нам:

📞 ${BOT_CONFIG.supportPhone}

Или напишите в группу: ${BOT_CONFIG.vkPatientLink}`;

const DOVEREN_MESSAGE = `📝 **Доверенность на получение документов**

Для оформления доверенности обратитесь к нам:

📞 ${BOT_CONFIG.supportPhone}

Мы поможем оформить все необходимые документы.`;

const PODDERZHKA_MESSAGE = `💖 **Поддержать проект**

Вы можете помочь проекту «Фельдшеръ.Рядом» развиваться:

Выберите способ поддержки:`;

const PRIVACY_MESSAGE = `🔒 **Политика конфиденциальности**

Полная версия политики конфиденциальности доступна по ссылке:

 ${BOT_CONFIG.privacyLink}`;

const CHANNELS_MESSAGE = `📢 **Наши каналы**

Подпишитесь на наши каналы в MAX:`;

const REVOKE_MESSAGE = `⚠️ **Удаление данных**

Вы уверены, что хотите удалить все ваши данные из бота?

Это действие нельзя отменить.`;

// ============== HELPER FUNCTIONS ==============

function getUserId(ctx: any): number | null {
  if (ctx.user?.user_id) return ctx.user.user_id;
  if (ctx.user?.id) return ctx.user.id;
  if (ctx.callback?.user?.user_id) return ctx.callback.user.user_id;
  if (ctx.message?.sender?.user_id) return ctx.message.sender.user_id;
  
  const update = ctx.update;
  if (update?.callback?.user?.user_id) return update.callback.user.user_id;
  if (update?.message?.sender?.user_id) return update.message.sender.user_id;
  if (update?.user?.user_id) return update.user.user_id;
  
  log('WARN', 'Could not get user ID from context', {
    hasUser: !!ctx.user,
    hasCallback: !!ctx.callback,
    hasMessage: !!ctx.message,
    updateType: ctx.updateType || ctx.update?.update_type,
  });
  
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
    if (error.code === 'chat.denied' || error.message?.includes('denied') || error.message?.includes('suspended')) {
      const userId = getUserId(ctx);
      if (userId) {
        log('INFO', `User ${userId} blocked the bot, cleaning up data`);
        await deleteAllUserData(userId);
      }
      return false;
    }
    throw error;
  }
}

// ============== NOTIFICATION FUNCTIONS ==============

async function sendNotification(message: string, urgent: boolean = false) {
  try {
    // Сначала пробуем канал
    if (CHANNEL_ID) {
      const chatId = parseInt(CHANNEL_ID);
      await bot.api.sendMessageToChat(chatId, message);
    }
  } catch (e) {
    // Если канал недоступен - отправляем админу
    try {
      await bot.api.sendMessageToChat(ADMIN_ID, message);
    } catch (e2) {
      log('ERROR', 'Failed to send notification', e2);
    }
  }
}

async function notifyAdmin(type: 'waitlist' | 'feldsher' | 'question', data: any) {
  let message = '';
  
  // Расшифровываем телефон для уведомления
  const phone = decrypt(data.phone);
  
  switch (type) {
    case 'waitlist':
      message = `📋 Новая заявка в лист ожидания:

👤 Имя: ${data.name}
📞 Телефон: ${phone}
📍 Район: ${data.district}`;
      break;
    case 'feldsher':
      message = `👨‍⚕️ Новая анкета фельдшера:

👤 Имя: ${data.name}
📞 Телефон: ${phone}
⏳ Стаж: ${data.experience}
📅 График: ${data.scheduleType}
📎 Резюме: ${data.resumeLink || 'не указано'}`;
      break;
    case 'question':
      message = `❓ Новый вопрос:

👤 Имя: ${data.name}
📞 Телефон: ${phone}
💬 Вопрос: ${data.question}`;
      break;
  }
  
  if (message) {
    await sendNotification(message);
  }
}

async function notifySuspiciousActivity(userId: number, reason: string, details?: any) {
  const message = `⚠️ Подозрительная активность!

👤 Пользователь: ${userId}
❓ Причина: ${reason}
 ${details ? `📋 Детали: ${JSON.stringify(details)}` : ''}
🕐 Время: ${new Date().toISOString()}`;
  
  await sendNotification(message, true);
  securityLog('SUSPICIOUS_ACTIVITY', userId, { reason, details });
}

// ============== BACKUP FUNCTIONS ==============

async function createBackup() {
  try {
    const dbPath = join(dataDir, 'database.sqlite');
    if (!existsSync(dbPath)) {
      log('WARN', 'Database file not found for backup');
      return;
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(dataDir, 'backups', `backup-${timestamp}.sqlite`);
    
    // Создаём папку для бэкапов
    const backupDir = join(dataDir, 'backups');
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    
    // Копируем файл
    const dbContent = readFileSync(dbPath);
    writeFileSync(backupPath, dbContent);
    
    log('INFO', `Backup created: ${backupPath}`);
    
    // Уведомление о бэкапе
    const message = `💾 Бэкап базы данных создан

🕐 Время: ${new Date().toISOString()}
📁 Файл: backup-${timestamp}.sqlite
📊 Размер: ${(dbContent.length / 1024).toFixed(2)} KB`;
    
    await sendNotification(message);
    
    // Удаляем старые бэкапы (оставляем последние 7)
    const files = readdirSync(backupDir)
      .filter(f => f.startsWith('backup-'))
      .sort()
      .reverse();
    
    for (let i = 7; i < files.length; i++) {
      try {
        unlinkSync(join(backupDir, files[i]));
        log('INFO', `Deleted old backup: ${files[i]}`);
      } catch (e) {}
    }
    
    return backupPath;
  } catch (e) {
    log('ERROR', 'Backup failed', e);
    return null;
  }
}

// Бэкап каждые 6 часов
setInterval(createBackup, 6 * 60 * 60 * 1000);

// ============== HEALTH CHECK ENDPOINT ==============
// Простой HTTP сервер для health check (без sensitive данных)

async function startHealthServer() {
  const http = require('http');
  const server = http.createServer((req: any, res: any) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '11.0'
      }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  
  server.listen(BOT_CONFIG.port, () => {
    log('INFO', `Health check server started on port ${BOT_CONFIG.port}`);
  });
}

// ============== MIDDLEWARE - RATE LIMITING ==============

bot.use(async (ctx, next) => {
  const id = getUserId(ctx);
  
  if (id) {
    const rateCheck = checkRateLimit(id);
    
    if (!rateCheck.allowed) {
      log('WARN', `Rate limit exceeded for user ${id}`);
      await notifySuspiciousActivity(id, 'RATE_LIMIT_EXCEEDED');
      return; // Молча игнорируем, не блокируем пользователя
    }
    
    if (rateCheck.warn) {
      log('WARN', `Rate limit warning for user ${id}, remaining: ${rateCheck.remaining}`);
    }
  }
  
  return next();
});

// ============== MIDDLEWARE - ПРОВЕРКА СОГЛАСИЯ ==============

bot.use(async (ctx, next) => {
  const id = getUserId(ctx);
  const updateType = ctx.updateType || ctx.update?.update_type || '';
  const callbackData = ctx.callback?.payload || ctx.update?.callback?.payload || '';
  
  if (!id) {
    return next();
  }

  // Разрешаем обработку согласия без проверки
  if (callbackData === 'consent_yes' || callbackData === 'consent_no' || callbackData === 'consent_retry') {
    return next();
  }

  await getOrCreateUser(id, getUserData(ctx));

  const hasConsent = await hasUserConsent(id);
  
  if (!hasConsent) {
    log('INFO', `Middleware: User ${id} has no consent, showing consent message`);
    
    if (updateType === 'message_callback' || ctx.callback) {
      try {
        await ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
      } catch (e) {
        log('ERROR', 'Middleware callback reply error', e);
      }
      return;
    }
    
    try {
      await ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
    } catch (e) {
      log('ERROR', 'Middleware message reply error', e);
    }
    return;
  }

  return next();
});

// ============== BOT STARTED ==============

bot.on('bot_started', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `bot_started event, userId: ${id}`);

  if (!id) return;

  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

// ============== COMMANDS ==============

bot.command('start', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/start command, userId: ${id}`);

  if (!id) return;
  
  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

bot.command('patient', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, PATIENT_MENU_MESSAGE, { attachments: [PatientKeyboard] });
});

bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/waitlist command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting waitlist flow`);
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_START', id);
  await safeReply(ctx, 'Напишите имя');
});

bot.command('order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/question command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting question flow`);
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_START', id);
  await safeReply(ctx, 'Напишите ваше имя');
});

bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/feldsher command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting feldsher flow`);
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_START', id);
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

  await setUserState(id, 'revoke', 'confirm', {});
  await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PRIVACY_MESSAGE, { attachments: [PrivacyKeyboard] });
});

bot.command('channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, CHANNELS_MESSAGE, { attachments: [ChannelsKeyboard] });
});

bot.command('admin_stats', async (ctx) => {
  const id = getUserId(ctx);
  if (!id || id !== ADMIN_ID) {
    return;
  }
  
  const waitlistCount = await prisma.maxWaitlistEntry.count();
  const feldsherCount = await prisma.maxFeldsherApplication.count();
  const questionsCount = await prisma.maxQuestion.count();
  
  await safeReply(ctx, `📊 **Статистика:**
  
📋 Лист ожидания: ${waitlistCount} заявок
👨‍⚕️ Анкеты фельдшеров: ${feldsherCount}
❓ Вопросы: ${questionsCount}`);
});

bot.command('backup', async (ctx) => {
  const id = getUserId(ctx);
  if (!id || id !== ADMIN_ID) {
    return;
  }
  
  const backupPath = await createBackup();
  if (backupPath) {
    await safeReply(ctx, `✅ Бэкап создан: ${backupPath}`);
  } else {
    await safeReply(ctx, `❌ Ошибка создания бэкапа`);
  }
});

// ============== CONSENT CALLBACKS ==============

bot.action('consent_yes', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `consent_yes callback, userId: ${id}`);
  
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));
  await setUserConsent(id, true);
  securityLog('CONSENT_GRANTED', id);
  
  await safeReply(ctx, '✅ Спасибо за согласие! Теперь вы можете пользоваться ботом.', { attachments: [MainKeyboard] });
});

bot.action('consent_no', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `consent_no callback, userId: ${id}`);
  
  if (!id) return;
  
  securityLog('CONSENT_DENIED', id);
  await safeReply(ctx, '❌ Без согласия функционал бота недоступен. Напишите /start чтобы попробовать снова.');
});

bot.action('consent_retry', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  
  await safeReply(ctx, CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
});

// ============== MENU CALLBACKS ==============

bot.action('main_menu', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `main_menu callback, userId: ${id}`);
  
  if (!id) return;
  
  await clearUserState(id);
  await safeReply(ctx, WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

bot.action('menu_patient', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_patient callback, userId: ${id}`);
  
  if (!id) return;

  await clearUserState(id);
  await safeReply(ctx, PATIENT_MENU_MESSAGE, { attachments: [PatientKeyboard] });
});

bot.action('menu_feldsher', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_feldsher callback, userId: ${id}`);
  
  if (!id) return;

  await clearUserState(id);
  await safeReply(ctx, FELDSHER_MENU_MESSAGE, { attachments: [FeldsherKeyboard] });
});

bot.action('menu_question', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_question callback, userId: ${id}`);
  
  if (!id) return;

  await clearUserState(id);
  await safeReply(ctx, QUESTION_MENU_MESSAGE, { attachments: [QuestionKeyboard] });
});

bot.action('menu_about', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, ABOUT_MESSAGE, { attachments: [BackKeyboard] });
});

// ========== PATIENT WAITLIST ==========

bot.action('patient_waitlist', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `patient_waitlist callback, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `Starting waitlist flow for user ${id}`);
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_START', id);
  await safeReply(ctx, 'Напишите имя');
});

bot.action('patient_order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

// ========== MENU QUESTION ==========

bot.action('question_ask', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `question_ask callback, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `Starting question flow for user ${id}`);
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_START', id);
  await safeReply(ctx, 'Напишите ваше имя');
});

// ========== FELDSHER APPLY ==========

bot.action('feldsher_apply', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `feldsher_apply callback, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `Starting feldsher flow for user ${id}`);
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_START', id);
  await safeReply(ctx, 'Как вас зовут?');
});

bot.action('feldsher_about', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, ABOUT_MESSAGE, { attachments: [BackKeyboard] });
});

// ========== CHANNEL LINKS ==========

bot.action('channel_patient', async (ctx) => {
  await safeReply(ctx, `👥 Канал для пациентов:\n\n${BOT_CONFIG.patientChannelLink}`);
});

bot.action('channel_feldsher', async (ctx) => {
  await safeReply(ctx, `👨‍⚕️ Канал для фельдшеров:\n\n${BOT_CONFIG.feldsherChannelLink}`);
});

// ========== PODDERZHKA LINKS ==========

bot.action('podderzhka_sber', async (ctx) => {
  await safeReply(ctx, `💳 Поддержать через Сбербанк Онлайн:\n\n${BOT_CONFIG.sberLink}`);
});

bot.action('podderzhka_planeta', async (ctx) => {
  await safeReply(ctx, `🌍 Поддержать на Planeta.ru:\n\n${BOT_CONFIG.planetaLink}`);
});

// ========== CANCEL FLOW ==========

bot.action('cancel_flow', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `cancel_flow callback, userId: ${id}`);
  
  if (!id) return;
  
  await clearUserState(id);
  await safeReply(ctx, '❌ Операция отменена. Выберите действие:', { attachments: [MainKeyboard] });
});

// ========== REVOKE CONFIRM ==========

bot.action('revoke_confirm', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `revoke_confirm callback, userId: ${id}`);
  
  if (!id) return;
  
  await deleteAllUserData(id);
  securityLog('DATA_REVOKED', id);
  
  log('INFO', `User ${id} revoked consent and deleted data`);
  await safeReply(ctx, '✅ Ваши данные удалены. Если передумаете, нажмите /start.');
});

// ========== DISTRICT SELECTION ==========

bot.action(/district_(\d)/, async (ctx) => {
  const id = getUserId(ctx);
  const districtId = ctx.match?.[1] || '';
  
  log('INFO', `district_${districtId} callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'waitlist') return;
  
  const district = BOT_CONFIG.districts.find(d => d.id === districtId);
  if (!district) return;
  
  const data = { ...state.data, district: district.name };
  await setUserState(id, 'waitlist', 'preview', data);
  
  const preview = `📋 Новая заявка в лист ожидания:

👤 Имя: ${data.name}
📞 Телефон: ${data.phone}
📍 Район: ${data.district}`;
  
  await safeReply(ctx, preview, { attachments: [ConfirmKeyboard] });
});

// ========== SCHEDULE SELECTION ==========

bot.action('schedule_main', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_main callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  
  const data = { ...state.data, scheduleType: '16 смен (основной фельдшер)' };
  await setUserState(id, 'feldsher', 'resume', data);
  
  await safeReply(ctx, 'Ссылка на ваше резюме или опишите свой опыт кратко в произвольной форме');
});

bot.action('schedule_sunday', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_sunday callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  
  const data = { ...state.data, scheduleType: '12 смен (воскресный фельдшер)' };
  await setUserState(id, 'feldsher', 'resume', data);
  
  await safeReply(ctx, 'Ссылка на ваше резюме или опишите свой опыт кратко в произвольной форме');
});

// ========== CONFIRM SUBMIT ==========

bot.action('confirm_submit', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `confirm_submit callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state) return;
  
  try {
    if (state.flowType === 'waitlist') {
      await saveWaitlistEntry(id, state.data);
      await notifyAdmin('waitlist', state.data);
      securityLog('WAITLIST_SUBMITTED', id);
      await clearUserState(id);
      await safeReply(ctx, `✅ Спасибо ${state.data.name}. Вы добавлены в лист ожидания.`);
    } else if (state.flowType === 'feldsher') {
      await saveFeldsherApplication(id, state.data);
      await notifyAdmin('feldsher', state.data);
      securityLog('FELDSHER_SUBMITTED', id);
      await clearUserState(id);
      await safeReply(ctx, `✅ Спасибо ${state.data.name}. Мы получили вашу анкету и свяжемся с вами в ближайшее время, чтобы назначить собеседование.`);
    } else if (state.flowType === 'question') {
      await saveQuestion(id, state.data);
      await notifyAdmin('question', state.data);
      securityLog('QUESTION_SUBMITTED', id);
      await clearUserState(id);
      await safeReply(ctx, '✅ Спасибо за вопрос. Мы получили его и свяжемся с вами в ближайшее время.');
    }
  } catch (e) {
    log('ERROR', 'Error submitting form', e);
    await safeReply(ctx, '❌ Произошла ошибка. Попробуйте позже.', { attachments: [MainKeyboard] });
  }
});

// ============== MESSAGE HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text;
  
  log('INFO', `message_created, userId: ${id}, text: ${text}`);
  
  if (!id || !text) return;
  
  const state = await getUserState(id);
  
  if (!state) {
    await safeReply(ctx, 'Выберите действие:', { attachments: [MainKeyboard] });
    return;
  }
  
  const sanitizedText = sanitizeInput(text, state?.flowType === 'question' && state?.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);
  
  // ========== WAITLIST FLOW ==========
  if (state.flowType === 'waitlist') {
    if (state.currentStep === 'name') {
      const data = { name: sanitizedText };
      await setUserState(id, 'waitlist', 'phone', data);
      await safeReply(ctx, 'Ваш номер телефона (в формате: +7-9ххххххххх)');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Попробуйте ещё раз (в формате: +7-9ххххххххх)');
        return;
      }
      const data = { ...state.data, phone: formatPhone(sanitizedText) };
      await setUserState(id, 'waitlist', 'district', data);
      await safeReply(ctx, 'Выберите кнопкой предпочтительный район обслуживания', { attachments: [DistrictsKeyboard] });
    }
  }
  
  // ========== FELDSHER FLOW ==========
  else if (state.flowType === 'feldsher') {
    if (state.currentStep === 'name') {
      const data = { name: sanitizedText };
      await setUserState(id, 'feldsher', 'phone', data);
      await safeReply(ctx, 'Ваш номер телефона (в формате: +7-9ххххххххх)');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Попробуйте ещё раз (в формате: +7-9ххххххххх)');
        return;
      }
      const data = { ...state.data, phone: formatPhone(sanitizedText) };
      await setUserState(id, 'feldsher', 'experience', data);
      await safeReply(ctx, 'Общий стаж работы фельдшером (лет):');
    } else if (state.currentStep === 'experience') {
      if (!validateExperience(sanitizedText)) {
        await safeReply(ctx, '❌ Укажите стаж цифрой (от 0 до 50 лет):');
        return;
      }
      const data = { ...state.data, experience: sanitizedText };
      await setUserState(id, 'feldsher', 'schedule', data);
      await safeReply(ctx, 'Какой график вы предпочитаете?', { attachments: [ScheduleKeyboard] });
    } else if (state.currentStep === 'resume') {
      const urlValidation = validateUrl(sanitizedText);
      if (!urlValidation.valid) {
        await safeReply(ctx, '❌ Неверный формат. Отправьте ссылку или опишите опыт:');
        return;
      }
      const data = { ...state.data, resumeLink: urlValidation.value };
      await setUserState(id, 'feldsher', 'preview', data);
      
      const preview = `👨‍⚕️ Новая анкета фельдшера:

👤 Имя: ${data.name}
📞 Телефон: ${data.phone}
⏳ Стаж: ${data.experience}
📅 График: ${data.scheduleType}
📎 Резюме: ${data.resumeLink || 'не указано'}`;
      
      await safeReply(ctx, preview, { attachments: [ConfirmKeyboard] });
    }
  }
  
  // ========== QUESTION FLOW ==========
  else if (state.flowType === 'question') {
    if (state.currentStep === 'name') {
      const data = { name: sanitizedText };
      await setUserState(id, 'question', 'phone', data);
      await safeReply(ctx, 'Напишите ваш номер телефона для связи (в формате: +7-9ххххххххх)');
    } else if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Попробуйте ещё раз (в формате: +7-9ххххххххх)');
        return;
      }
      const data = { ...state.data, phone: formatPhone(sanitizedText) };
      await setUserState(id, 'question', 'question', data);
      await safeReply(ctx, 'Задайте ваш вопрос. Мы ответим вам в ближайшее время.');
    } else if (state.currentStep === 'question') {
      const data = { ...state.data, question: sanitizedText };
      await setUserState(id, 'question', 'preview', data);
      
      const preview = `❓ Новый вопрос:

👤 Имя: ${data.name}
📞 Телефон: ${data.phone}
💬 Вопрос: ${data.question}`;
      
      await safeReply(ctx, preview, { attachments: [ConfirmKeyboard] });
    }
  }
});

// ============== ERROR HANDLING ==============

bot.catch((err, ctx) => {
  log('ERROR', 'Bot error', err);
  console.error('Bot error: ', err);
});

// ============== START BOT ==============

async function main() {
  log('INFO', 'Starting bot v11.0...');
  
  try {
    await prisma.$connect();
    log('INFO', 'Database connected');
  } catch (e) {
    log('ERROR', 'Database connection error', e);
    process.exit(1);
  }
  
  // Создаём начальный бэкап
  await createBackup();
  
  // Запускаем health check сервер
  startHealthServer();
  
  try {
    await bot.start();
    log('INFO', 'Bot started successfully');
    
    // Уведомление о запуске
    await sendNotification(`🤖 Бот запущен (v11.0)\n🕐 ${new Date().toISOString()}`);
  } catch (e) {
    log('ERROR', 'Bot start error', e);
    process.exit(1);
  }
}

main();

process.on('SIGINT', async () => {
  log('INFO', 'Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('INFO', 'Shutting down...');
  await prisma.$disconnect();
  process.exit(0);
});
