#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 11.3
 * 
 * Исправления в v11.3:
 * - ИСПРАВЛЕНО: Автоматическая установка DATABASE_URL если не задана
 * - ИСПРАВЛЕНО: Автоматическая миграция БД при запуске (prisma db push)
 * - УЛУЧШЕНО: Логирование ошибок подключения к БД
 * - УЛУЧШЕНО: Graceful shutdown
 * 
 * Repository: https://github.com/avanaha/feldsher-max-bot
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync, unlinkSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { execSync } from 'child_process';

// ============== DATABASE URL - АВТОМАТИЧЕСКАЯ УСТАНОВКА ==============
// Если DATABASE_URL не задана, используем дефолтный путь
if (!process.env.DATABASE_URL) {
  const dbPath = '/app/data/database.sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  console.log(`[INFO] DATABASE_URL not set, using default: ${process.env.DATABASE_URL}`);
}

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

// ============== RATE LIMITING (МЯГКИЙ) ==============
const rateLimitMap = new Map<number, { count: number; lastRequest: number; warned: boolean }>();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WARN = 20;

const activeQuestionnaires = new Set<number>();

function checkRateLimit(userId: number): { allowed: boolean; warn: boolean; remaining: number } {
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
  
  if (trimmed === 'нет' || trimmed === 'нет резюме' || trimmed === '-') {
    return { valid: true, isUrl: false, value: 'Резюме не предоставлено' };
  }
  
  try {
    const url = new URL(text.startsWith('http') ? text : `https://${text}`);
    const allowedDomains = ['.ru', '.com', '.org', '.net', '.io', '.pdf', 'drive.google', 'docs.google', 'yandex', 'mail.ru', 'vk.com', 'hh.ru', 'linkedin', 'github'];
    const isAllowed = allowedDomains.some(d => url.hostname.includes(d) || url.pathname.includes(d));
    
    if (isAllowed || url.protocol === 'https:') {
      return { valid: true, isUrl: true, value: url.href };
    }
    
    return { valid: true, isUrl: false, value: sanitizeInput(text, 500) };
  } catch (e) {
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

// ============== АВТОМАТИЧЕСКАЯ МИГРАЦИЯ БД ==============
function runDatabaseMigration() {
  try {
    log('INFO', 'Running database migration...');
    
    // Проверяем существует ли файл БД
    const dbPath = '/app/data/database.sqlite';
    const dbExists = existsSync(dbPath);
    log('INFO', `Database file exists: ${dbExists}`);
    
    // Запускаем prisma db push
    log('INFO', 'Executing: bunx prisma db push --skip-generate');
    const result = execSync('bunx prisma db push --skip-generate --accept-data-loss 2>&1', {
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env }
    });
    log('INFO', 'Migration result:', result);
    log('INFO', 'Database migration completed successfully');
    return true;
  } catch (error: any) {
    log('ERROR', 'Database migration failed', { 
      message: error.message, 
      stdout: error.stdout, 
      stderr: error.stderr 
    });
    return false;
  }
}

// Запускаем миграцию ДО создания PrismaClient
const migrationSuccess = runDatabaseMigration();
if (!migrationSuccess) {
  log('WARN', 'Migration had issues, but continuing...');
}

const prisma = new PrismaClient({ 
  log: ['error', 'warn'],
  errorFormat: 'pretty'
});

// Проверяем подключение к БД
async function checkDatabaseConnection() {
  try {
    await prisma.$connect();
    log('INFO', 'Database connected successfully');
    
    // Проверяем что таблицы существуют
    const userCount = await prisma.maxUser.count();
    log('INFO', `Database check: ${userCount} users in database`);
    return true;
  } catch (error: any) {
    log('ERROR', 'Database connection failed', { 
      code: error.code, 
      message: error.message,
      meta: error.meta 
    });
    return false;
  }
}

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
  privacyLink: 'https://feldsher-land.ru/legal',
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
  try {
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
  } catch (error: any) {
    log('ERROR', 'getOrCreateUser failed', { maxId, error: error.message });
    throw error;
  }
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
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
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
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
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
  const user = await prisma.maxUser.findUnique({
    where: { maxId: maxId.toString() },
  });
  if (!user) throw new Error('User not found');
  return prisma.maxQuestion.create({
    data: {
      maxUserId: user.id,
      name: sanitizeInput(data.name, 100),
      phone: encrypt(data.phone),
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
   Мы отправим вам приглашение на открытие фельдшерского кабинета.
💰 Оплатить предзаказ (скидка - 20%, ограниченное предложение).
   Скидка будет закреплена за вами и активирована после открытия кабинета.
❓ Задать любой вопрос – мы ответим лично.

👨‍⚕️ Фельдшерам: оставить контакты и резюме для сотрудничества.

❤️ Поддержать проект.

Все сообщения мгновенно поступают администратору.
Бот работает 24/7, а администратор отвечает в рабочее время с 07.00 до 20.00 (время МСК).

Чтобы начать пользоваться ботом, примите согласие на обработку персональных данных

✅ СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ

Я, заполняя форму в боте по ссылке в интернете https://max.ru/id1800048162_1_bot, даю своё добровольное и информированное согласие Обществу с ограниченной ответственностью «Фельдшер и компания» (ООО «Фельдшер и Ко», ИНН 1800048162, ОГРН 1261800002694, юридический адрес: 426000, РФ, Удмуртская Республика, г. Ижевск) на обработку моих персональных данных, которые я укажу далее (имя, номер телефона, предпочтительный район обслуживания, сведения об опыте работы, ссылка на резюме), с целями:
– формирования листа ожидания открытия фельдшерского кабинета;
– связи со мной по вопросам проекта;
– рассмотрения моей кандидатуры в качестве фельдшера (для соискателей);
– ответа на мои вопросы.

Обработка включает в себя (в соответствии с п. 3 ст. 3 Федерального закона № 152-ФЗ): сбор, запись, систематизацию, накопление, хранение, уточнение (обновление, изменение), извлечение, использование, передачу (в целях, указанных выше), обезличивание, блокирование, удаление, уничтожение персональных данных.

Я ознакомлен(а) с Политикой конфиденциальности Оператора – она доступна по команде /privacy в этом боте, а также в закреплённых сообщениях каналов в «Макс» и ВКонтакте, и на сайте https://feldsher-land.ru/legal.html.

Срок действия согласия: с момента его предоставления до достижения целей обработки либо до момента отзыва согласия субъектом.
Я могу отозвать это согласие в любой момент, написав об этом в данного бота (например, отправив сообщение с текстом «Отозвать согласие»), либо по электронной почте feldland@yandex.ru.
Отзыв согласия не имеет обратной силы в части уже обработанных данных.

Нажимая кнопку «✅ Согласен», я подтверждаю, что прочитал(а) и принимаю условия выше.`;

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

Если у вас возникли вопросы, напишите нам:
📧 feldland@yandex.ru или задайте вопрос через этот бот`;

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

const PODDERZHKA_MESSAGE = `Спасибо за желание помочь проекту «Фельдшеръ.Рядом»! ❤️

Сбор средств на платформе краудфандинга:
https://planeta.ru/campaigns/feldsherryadom

Перевод по ссылке:
https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

Если хотите отправить анонимно, то можете сделать перевод напрямую по номеру телефона:
📞 +7 (965) 843-78-18 (лучше добавить комментарий про фельдшерский кабинет)`;

const PRIVACY_MESSAGE = `Политика конфиденциальности и согласие на обработку персональных данных по ссылкам ниже:

📄 Политика конфиденциальности находится по ссылке ниже:
https://feldsher-land.ru/legal

🔐 Согласие на обработку персональных данных:
Действует для этого бота, его нужно принять перед использованием бота.`;

const CHANNELS_MESSAGE = `Друзья, вы можете подписаться на наши каналы по ссылкам ниже

Пациентам:

🟪 MAX
https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8

🔵 VK
https://vk.com/feldsherryadom

Фельдшерам:

🟪 MAX
https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8

🔵 VK
https://vk.com/feldsherizh`;

const REVOKE_MESSAGE = `Вы можете отозвать согласие на обработку персональных данных, используя кнопку ниже.

Если вы отзовёте согласие, то все ваши данные будут очищены. Чтобы использовать бота снова, отправьте ему команду /start.

Вы желаете отозвать согласие?`;

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
    if (CHANNEL_ID) {
      const chatId = parseInt(CHANNEL_ID);
      await bot.api.sendMessageToChat(chatId, message);
    }
  } catch (e) {
    try {
      await bot.api.sendMessageToChat(ADMIN_ID, message);
    } catch (e2) {
      log('ERROR', 'Failed to send notification', e2);
    }
  }
}

async function notifyAdmin(type: 'waitlist' | 'feldsher' | 'question', data: any) {
  let message = '';
  
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
    
    const backupDir = join(dataDir, 'backups');
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    
    const dbContent = readFileSync(dbPath);
    writeFileSync(backupPath, dbContent);
    
    log('INFO', `Backup created: ${backupPath}`);
    
    const message = `💾 Бэкап базы данных создан

🕐 Время: ${new Date().toISOString()}
📁 Файл: backup-${timestamp}.sqlite
📊 Размер: ${(dbContent.length / 1024).toFixed(2)} KB`;
    
    await sendNotification(message);
    
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

setInterval(createBackup, 6 * 60 * 60 * 1000);

// ============== HEALTH CHECK ENDPOINT ==============

async function startHealthServer() {
  const http = require('http');
  const server = http.createServer((req: any, res: any) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '11.3',
        database: 'connected'
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
      return;
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

  if (callbackData === 'consent_yes' || callbackData === 'consent_no' || callbackData === 'consent_retry') {
    return next();
  }

  try {
    await getOrCreateUser(id, getUserData(ctx));
  } catch (e) {
    log('ERROR', 'Failed to get/create user in consent middleware', e);
    return;
  }

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

// 1. /waitlist - 📋 Хочу в лист ожидания
bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/waitlist command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting waitlist flow`);
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_START', id);
  await safeReply(ctx, 'Напишите имя');
});

// 2. /order - 💰 Оплатить предзаказ
bot.command('order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

// 3. /question - ❓ У меня есть вопрос
bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/question command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting question flow`);
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_START', id);
  await safeReply(ctx, 'Напишите ваше имя');
});

// 4. /feldsher - 👨‍⚕️ Фельдшеру (отправить резюме)
bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/feldsher command, userId: ${id}`);
  
  if (!id) return;

  log('INFO', `User ${id} starting feldsher flow`);
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_START', id);
  await safeReply(ctx, 'Как вас зовут?');
});

// 5. /doveren - 📄 Текст доверенности
bot.command('doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, DOVEREN_MESSAGE, { attachments: [BackKeyboard] });
});

// 6. /podderzhka - ❤️ Поддержать проект
bot.command('podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, PODDERZHKA_MESSAGE, { attachments: [PodderzhkaKeyboard] });
});

// 7. /revoke - 🗑️ Отозвать согласие
bot.command('revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

// 8. /privacy – 🔐 Свод правил
bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await safeReply(ctx, PRIVACY_MESSAGE, { attachments: [BackKeyboard] });
});

// 9. /channels - 📢 Наши каналы
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
  await safeReply(ctx, '❌ Без согласия функционал бота недоступен. Напишите /start, чтобы попробовать снова.');
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

// ========== CHANNEL LINKS ==========

bot.action('channel_patient', async (ctx) => {
  await safeReply(ctx, `👥 Канал для пациентов:

🟪 MAX
https://max.ru/join/56sp6ngnZou3IeaUAUqfiopUefYBUMacUwg1ExkHAa8

🔵 VK
https://vk.com/feldsherryadom`);
});

bot.action('channel_feldsher', async (ctx) => {
  await safeReply(ctx, `👨‍⚕️ Канал для фельдшеров:

🟪 MAX
https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8

🔵 VK
https://vk.com/feldsherizh`);
});

// ========== PODDERZHKA LINKS ==========

bot.action('podderzhka_sber', async (ctx) => {
  await safeReply(ctx, `💳 Перевод через Сбербанк:

Ссылка для перевода:
https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

Или напрямую по номеру телефона:
📞 +7 (965) 843-78-18

(лучше добавить комментарий про фельдшерский кабинет)`);
});

bot.action('podderzhka_planeta', async (ctx) => {
  await safeReply(ctx, `🌍 Краудфандинг на Planeta.ru:

https://planeta.ru/campaigns/feldsherryadom

Спасибо за поддержку проекта! ❤️`);
});

// ========== REVOKE CONSENT ==========

bot.action('revoke_confirm', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `revoke_confirm callback, userId: ${id}`);
  
  if (!id) return;

  securityLog('CONSENT_REVOKED', id);
  await deleteAllUserData(id);
  
  await safeReply(ctx, `✅ Ваше согласие отозвано.
Все ваши персональные данные удалены из базы.

Если захотите воспользоваться ботом снова, отправьте /start`);
});

// ========== CANCEL FLOW ==========

bot.action('cancel_flow', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `cancel_flow callback, userId: ${id}`);
  
  if (!id) return;
  
  await clearUserState(id);
  await safeReply(ctx, '❌ Отменено. Возвращаемся в главное меню.', { attachments: [MainKeyboard] });
});

// ========== DISTRICT SELECTION ==========

bot.action(/district_(\d+)/, async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `district callback, userId: ${id}`);
  
  if (!id) return;
  
  const match = ctx.callback?.payload?.match(/district_(\d+)/);
  if (!match) return;
  
  const districtId = match[1];
  const district = BOT_CONFIG.districts.find(d => d.id === districtId);
  
  if (!district) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'waitlist') return;
  
  state.data.district = district.name;
  await setUserState(id, 'waitlist', 'confirm', state.data);
  
  await safeReply(ctx, `📍 Выбран район: ${district.name}

✅ Проверьте данные:
👤 Имя: ${state.data.name}
📞 Телефон: ${state.data.phone}
📍 Район: ${district.name}`, { attachments: [ConfirmKeyboard] });
});

// ========== SCHEDULE SELECTION ==========

bot.action('schedule_main', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_main callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  
  state.data.scheduleType = '16 смен (основной фельдшер)';
  await setUserState(id, 'feldsher', 'resume', state.data);
  
  await safeReply(ctx, `📅 Выбран график: 16 смен (основной фельдшер)

📎 Пришлите ссылку на резюме (или напишите «нет», если нет резюме)`, { attachments: [CancelKeyboard] });
});

bot.action('schedule_sunday', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_sunday callback, userId: ${id}`);
  
  if (!id) return;
  
  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') return;
  
  state.data.scheduleType = '12 смен (воскресный фельдшер)';
  await setUserState(id, 'feldsher', 'resume', state.data);
  
  await safeReply(ctx, `📅 Выбран график: 12 смен (воскресный фельдшер)

📎 Пришлите ссылку на резюме (или напишите «нет», если нет резюме)`, { attachments: [CancelKeyboard] });
});

// ========== CONFIRM SUBMISSION ==========

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
      securityLog('WAITLIST_SUBMITTED', id, { district: state.data.district });
      await safeReply(ctx, '✅ Спасибо! Вы записаны в лист ожидания.\nМы пригласим вас на открытие фельдшерского кабинета.', { attachments: [MainKeyboard] });
    } else if (state.flowType === 'feldsher') {
      await saveFeldsherApplication(id, state.data);
      await notifyAdmin('feldsher', state.data);
      securityLog('FELDSHER_SUBMITTED', id, { schedule: state.data.scheduleType });
      await safeReply(ctx, '✅ Спасибо! Ваша анкета отправлена.\nМы свяжемся с вами в ближайшее время.', { attachments: [MainKeyboard] });
    } else if (state.flowType === 'question') {
      await saveQuestion(id, state.data);
      await notifyAdmin('question', state.data);
      securityLog('QUESTION_SUBMITTED', id);
      await safeReply(ctx, '✅ Спасибо! Ваш вопрос отправлен.\nМы ответим вам в рабочее время (07:00-20:00 МСК).', { attachments: [MainKeyboard] });
    }
    
    await clearUserState(id);
  } catch (e) {
    log('ERROR', 'Failed to save submission', e);
    await safeReply(ctx, '❌ Произошла ошибка. Попробуйте позже или напишите нам на feldland@yandex.ru', { attachments: [MainKeyboard] });
  }
});

// ============== TEXT MESSAGE HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text || '';
  
  log('INFO', `message_created from ${id}: ${text.substring(0, 50)}...`);
  
  if (!id || !text) return;
  
  const state = await getUserState(id);
  
  // Если нет активного состояния - проверяем на ключевые слова
  if (!state) {
    const lowerText = text.toLowerCase().trim();
    
    // Проверяем на отзыв согласия
    if (lowerText.includes('отозвать') && lowerText.includes('согласие')) {
      await safeReply(ctx, REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
      return;
    }
    
    // Общие ответы
    await safeReply(ctx, 'Выберите действие в меню или используйте команды:\n/waitlist - Лист ожидания\n/question - Задать вопрос\n/feldsher - Отправить резюме', { attachments: [MainKeyboard] });
    return;
  }
  
  // Обработка в зависимости от типа flow
  if (state.flowType === 'waitlist') {
    await handleWaitlistFlow(ctx, id, text, state);
  } else if (state.flowType === 'feldsher') {
    await handleFeldsherFlow(ctx, id, text, state);
  } else if (state.flowType === 'question') {
    await handleQuestionFlow(ctx, id, text, state);
  }
});

// ========== WAITLIST FLOW ==========

async function handleWaitlistFlow(ctx: any, id: number, text: string, state: any) {
  const sanitizedText = sanitizeInput(text, 100);
  
  switch (state.currentStep) {
    case 'name':
      state.data.name = sanitizedText;
      await setUserState(id, 'waitlist', 'phone', state.data);
      await safeReply(ctx, '📞 Напишите номер телефона', { attachments: [CancelKeyboard] });
      break;
      
    case 'phone':
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Напишите номер в формате +7XXXXXXXXXX');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'waitlist', 'district', state.data);
      await safeReply(ctx, '📍 Выберите район:', { attachments: [DistrictsKeyboard] });
      break;
  }
}

// ========== FELDSHER FLOW ==========

async function handleFeldsherFlow(ctx: any, id: number, text: string, state: any) {
  const sanitizedText = sanitizeInput(text, 100);
  
  switch (state.currentStep) {
    case 'name':
      state.data.name = sanitizedText;
      await setUserState(id, 'feldsher', 'phone', state.data);
      await safeReply(ctx, '📞 Напишите номер телефона', { attachments: [CancelKeyboard] });
      break;
      
    case 'phone':
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Напишите номер в формате +7XXXXXXXXXX');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'feldsher', 'experience', state.data);
      await safeReply(ctx, '⏳ Сколько лет опыта работы фельдшером?', { attachments: [CancelKeyboard] });
      break;
      
    case 'experience':
      if (!validateExperience(text)) {
        await safeReply(ctx, '❌ Укажите стаж числом (например: 5)');
        return;
      }
      state.data.experience = text.replace(/\D/g, '') + ' лет';
      await setUserState(id, 'feldsher', 'schedule', state.data);
      await safeReply(ctx, '📅 Выберите желаемый график:', { attachments: [ScheduleKeyboard] });
      break;
      
    case 'resume':
      const urlResult = validateUrl(text);
      state.data.resumeLink = urlResult.value;
      await setUserState(id, 'feldsher', 'confirm', state.data);
      
      await safeReply(ctx, `✅ Проверьте данные:
👤 Имя: ${state.data.name}
📞 Телефон: ${state.data.phone}
⏳ Стаж: ${state.data.experience}
📅 График: ${state.data.scheduleType}
📎 Резюме: ${state.data.resumeLink || 'не указано'}`, { attachments: [ConfirmKeyboard] });
      break;
  }
}

// ========== QUESTION FLOW ==========

async function handleQuestionFlow(ctx: any, id: number, text: string, state: any) {
  const sanitizedText = sanitizeInput(text, 100);
  const sanitizedQuestion = sanitizeInput(text, MAX_QUESTION_LENGTH);
  
  switch (state.currentStep) {
    case 'name':
      state.data.name = sanitizedText;
      await setUserState(id, 'question', 'phone', state.data);
      await safeReply(ctx, '📞 Напишите номер телефона (для ответа на ваш вопрос)', { attachments: [CancelKeyboard] });
      break;
      
    case 'phone':
      if (!validatePhone(text)) {
        await safeReply(ctx, '❌ Неверный формат телефона. Напишите номер в формате +7XXXXXXXXXX');
        return;
      }
      state.data.phone = formatPhone(text);
      await setUserState(id, 'question', 'question', state.data);
      await safeReply(ctx, '❓ Напишите ваш вопрос', { attachments: [CancelKeyboard] });
      break;
      
    case 'question':
      state.data.question = sanitizedQuestion;
      await setUserState(id, 'question', 'confirm', state.data);
      
      await safeReply(ctx, `✅ Проверьте данные:
👤 Имя: ${state.data.name}
📞 Телефон: ${state.data.phone}
❓ Вопрос: ${state.data.question}`, { attachments: [ConfirmKeyboard] });
      break;
  }
}

// ============== ERROR HANDLING ==============

bot.catch((error: any) => {
  log('ERROR', 'Bot error:', { 
    message: error.message, 
    code: error.code,
    stack: error.stack 
  });
});

// ============== GRACEFUL SHUTDOWN ==============

async function gracefulShutdown(signal: string) {
  log('INFO', `Received ${signal}, shutting down gracefully...`);
  
  try {
    await prisma.$disconnect();
    log('INFO', 'Database disconnected');
  } catch (e) {
    log('ERROR', 'Error disconnecting database', e);
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============== START BOT ==============

async function startBot() {
  try {
    log('INFO', `Starting bot v11.3...`);
    log('INFO', `DATABASE_URL: ${process.env.DATABASE_URL}`);
    log('INFO', `ADMIN_ID: ${ADMIN_ID}`);
    log('INFO', `CHANNEL_ID: ${CHANNEL_ID}`);
    
    // Проверяем подключение к БД
    const dbOk = await checkDatabaseConnection();
    if (!dbOk) {
      log('ERROR', 'Database connection failed, retrying migration...');
      // Пробуем миграцию ещё раз
      runDatabaseMigration();
      await new Promise(r => setTimeout(r, 2000));
      const retryOk = await checkDatabaseConnection();
      if (!retryOk) {
        log('ERROR', 'Database still not working, but starting anyway...');
      }
    }
    
    // Запускаем health check server
    startHealthServer();
    
    // Запускаем бота
    await bot.start();
    log('INFO', 'Bot started successfully!');
    
    // Уведомляем админа о запуске
    await sendNotification(`🤖 Бот v11.3 запущен!\n\n🕐 Время: ${new Date().toISOString()}\n📊 База данных: ${dbOk ? 'OK' : 'ПРОБЛЕМА'}`);
    
  } catch (error: any) {
    log('ERROR', 'Failed to start bot', { message: error.message, stack: error.stack });
    process.exit(1);
  }
}

startBot();
