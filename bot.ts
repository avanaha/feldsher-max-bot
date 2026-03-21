#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 7.0 - Fixed callback handlers and consent flow
 * Repository: https://github.com/avanaha/feldsher-max-bot
 */

import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';
import { mkdirSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

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

// ============== VALIDATION ==============
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
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============== CONFIG ==============
const ADMIN_ID = parseInt(process.env.MAX_ADMIN_ID || '162749713');
const CHANNEL_ID = process.env.MAX_CHANNEL_ID || '-72328888338961';

function isAdmin(userId: number): boolean {
  return userId === ADMIN_ID;
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
  patientChannelLink: 'https://max.ru/join/TL81d4e3h5J-_txDDk7T0d_pa_kPUduvCNH5cg4aqzg',
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

  if (!message) return;

  if (BOT_CONFIG.channelId) {
    try {
      const chatId = parseInt(BOT_CONFIG.channelId);
      if (!isNaN(chatId)) {
        await bot.api.sendMessage(chatId, message);
        log('INFO', `Notification sent to channel ${BOT_CONFIG.channelId}`);
        return;
      }
    } catch (e) {
      log('WARN', 'Failed to send to channel, trying admin', e);
    }
  }

  if (ADMIN_ID) {
    try {
      await bot.api.sendMessage(ADMIN_ID, message);
      log('INFO', `Notification sent to admin ${ADMIN_ID}`);
    } catch (e) {
      log('ERROR', 'Failed to send notification', e);
    }
  }
}

// ============== VALIDATION ==============

function validatePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return true;
  }
  if (digits.length === 10) {
    return true;
  }
  const cleaned = phone.replace(/\s/g, '');
  return /^\+?[0-9][0-9\-\s]{9,15}$/.test(cleaned);
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return '+' + '7' + digits.slice(1);
  if (digits.startsWith('7') && digits.length === 11) return '+' + digits;
  if (digits.length === 10) return '+7' + digits;
  return phone;
}

function validateExperience(text: string): boolean {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 0) return false;
  const num = parseInt(digits);
  return num >= 0 && num <= 100;
}

// ============== MESSAGES ==============

const CONSENT_MESSAGE = `✅ СОГЛАСИЕ НА ОБРАБОТКУ ПЕРСОНАЛЬНЫХ ДАННЫХ

Я, заполняя форму в боте @id1800048162_1_bot (https://max.ru/id1800048162_1_bot), даю своё добровольное и информированное согласие
Обществу с ограниченной ответственностью «Фельдшер и компания»
(ООО «Фельдшер и Ко», ИНН 1800048162, ОГРН 1261800002694, юридический адрес: 426000, РФ, Удмуртская Республика, г. Ижевск)
на обработку моих персональных данных, которые я укажу далее (имя, номер телефона, предпочитаемый район обслуживания, сведения об опыте работы, ссылка на резюме), с целями:
– формирования листа ожидания открытия фельдшерского кабинета;
– связи со мной по вопросам проекта;
– рассмотрения моей кандидатуры в качестве фельдшера (для соискателей);
– ответа на мои вопросы.

Обработка включает в себя (в соответствии с п. 3 ст. 3 Федерального закона № 152-ФЗ): сбор, запись, систематизацию, накопление, хранение, уточнение (обновление, изменение), извлечение, использование, передачу (в целях, указанных выше), обезличивание, блокирование, удаление, уничтожение персональных данных.

Я ознакомлен(а) с Политикой конфиденциальности Оператора – она доступна по команде /privacy в этом боте, а также в закреплённых сообщениях каналов в «Макс» и ВКонтакте, и на сайте https://feldsher-land.ru/legal.html

Срок действия согласия: с момента его предоставления до достижения целей обработки либо до момента отзыва согласия субъектом.
Я могу отозвать это согласие в любой момент, написав об этом в данного бота (например, отправив сообщение с текстом «Отозвать согласие»), либо по электронной почте feldland@yandex.ru. Отзыв согласия не имеет обратной силы в части уже обработанных данных.

✅ Согласен (-на).
Ваш выбор означает, что вы прочитали условия и подтверждаете своё согласие на эти условия.

❌ Не согласен (-на).
Ваш выбор означает, что вы прочитали условия и не подтверждаете своё согласие на эти условия.
В этом случае, функционал бота будет вам недоступен.`;

const WELCOME_MESSAGE = `👋 Здравствуйте! Я бот проекта «Фельдшеръ.Рядом».

Я помогу:
📋 Записаться в лист ожидания открытия кабинета;
❓ Задать вопрос о проекте;
👨‍⚕️ Оставить резюме фельдшеру;
❤️ Поддержать проект.

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

const PRIVACY_MESSAGE = `🔐 СВОД ПРАВИЛ

Политика конфиденциальности и согласие на обработку персональных данных по ссылкам ниже:

📄 Политика конфиденциальности находится по ссылке:
https://feldsher-land.ru/legal

🔐 Согласие на обработку персональных данных:
Действует для этого бота, его нужно принять перед использованием бота.`;

const CHANNELS_MESSAGE = `📢 НАШИ КАНАЛЫ

Друзья, вы можете подписаться на наши каналы по ссылкам ниже:

Пациентам:

🟪 MAX
https://max.ru/join/TL81d4e3h5J-_txDDk7T0d_pa_kPUduvCNH5cg4aqzg

🔵 VK
https://vk.com/feldsherryadom

Фельдшерам:

🟪 MAX
https://max.ru/join/rre51qvmREhGKRnNFf4vcVZ_U3mj_obCY8L2wNHAxo8

🔵 VK
https://vk.com/feldsherizh`;

const PODDERZHKA_MESSAGE = `❤️ ПОДДЕРЖАТЬ ПРОЕКТ

Спасибо за желание помочь проекту «Фельдшеръ.Рядом»! ❤️

Сбор средств на платформе краудфандинга:
https://planeta.ru/campaigns/feldsherryadom

Перевод по ссылке:
https://messenger.online.sberbank.ru/sl/6Ih17pcLxfxgbjntM

Если хотите отправить анонимно, то можете сделать перевод напрямую по номеру телефона:
📞 +7 (965) 843-78-18 (лучше добавить комментарий про фельдшерский кабинет)`;

const ORDER_MESSAGE = `💰 ОПЛАТА ПРЕДЗАКАЗА

Для оплаты предзаказа воспользуйтесь ссылкой:
[Ссылка будет добавлена позже]

Если у вас возникли вопросы, напишите нам:
📧 feldland@yandex.ru`;

const REVOKE_MESSAGE = `🗑️ ОТЗЫВ СОГЛАСИЯ

Вы уверены, что хотите отозвать согласие на обработку персональных данных?

При отзыве согласия все ваши данные будут удалены из нашей базы данных, и вы потеряете доступ к функциям бота.`;

const PATIENT_MENU_MESSAGE = `📋 МЕНЮ ПАЦИЕНТА

Выберите действие:`;

const QUESTION_MENU_MESSAGE = `❓ ВОПРОСЫ

Выберите действие:`;

// ============== KEYBOARDS ==============

const ConsentKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Согласен (-на)', 'consent_yes')],
  [Keyboard.button.callback('❌ Не согласен (-на)', 'consent_no')],
]);

const MainKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 Пациентам', 'menu_patient')],
  [Keyboard.button.callback('❓ У меня есть вопрос', 'menu_question')],
  [Keyboard.button.callback('👨‍⚕️ Фельдшеру – отправить резюме', 'menu_feldsher')],
  [Keyboard.button.callback('📄 Текст доверенности', 'menu_doveren')],
  [Keyboard.button.callback('❤️ Поддержать проект', 'menu_podderzhka')],
  [Keyboard.button.callback('🗑️ Отозвать согласие', 'menu_revoke')],
  [Keyboard.button.callback('🔐 Свод правил', 'menu_privacy')],
  [Keyboard.button.callback('📢 Наши каналы', 'menu_channels')],
]);

const PatientKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('📋 Хочу в лист ожидания', 'patient_waitlist')],
  [Keyboard.button.callback('💰 Оплатить предзаказ', 'patient_order')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const QuestionKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❓ Задать вопрос', 'question_ask')],
  [Keyboard.button.callback('🗑️ Отозвать согласие', 'menu_revoke')],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const CancelKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('❌ Отменить', 'cancel_flow')],
]);

function getDistrictKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('1. Индустриальный', 'district_1')],
    [Keyboard.button.callback('2. Ленинский', 'district_2')],
    [Keyboard.button.callback('3. Октябрьский', 'district_3')],
    [Keyboard.button.callback('4. Первомайский', 'district_4')],
    [Keyboard.button.callback('5. Устиновский', 'district_5')],
  ]);
}

const ScheduleKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('16 смен (основной фельдшер)', 'schedule_16')],
  [Keyboard.button.callback('12 смен (воскресный фельдшер)', 'schedule_12')],
]);

const ConfirmKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Отправить', 'confirm_send')],
  [Keyboard.button.callback('❌ Не отправлять', 'confirm_cancel')],
  [Keyboard.button.callback('🏠 В главное меню', 'main_menu')],
]);

const RevokeKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('✅ Да, удалить мои данные', 'revoke_yes')],
  [Keyboard.button.callback('❌ Нет, я передумал', 'revoke_no')],
]);

const BackKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const ChannelsKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.link('🟪 MAX (пациентам)', BOT_CONFIG.patientChannelLink)],
  [Keyboard.button.link('🟪 MAX (фельдшерам)', BOT_CONFIG.feldsherChannelLink)],
  [Keyboard.button.link('🔵 VK (пациентам)', BOT_CONFIG.vkPatientLink)],
  [Keyboard.button.link('🔵 VK (фельдшерам)', BOT_CONFIG.vkFeldsherLink)],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const PodderzhkaKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.link('💰 Планета.ру', BOT_CONFIG.planetaLink)],
  [Keyboard.button.link('💳 Сбер', BOT_CONFIG.sberLink)],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

const PrivacyKeyboard = Keyboard.inlineKeyboard([
  [Keyboard.button.link('📄 Политика конфиденциальности', BOT_CONFIG.privacyLink)],
  [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
]);

// ============== HELPER ==============

function getUserId(ctx: any): number | null {
  // Для message_created
  let sender = ctx.sender || ctx.from || ctx.message?.sender;
  if (sender?.user_id) return sender.user_id;
  if (sender?.id) return sender.id;
  
  // Для callback_query (структура MAX API)
  if (ctx.callback_query) {
    sender = ctx.callback_query.sender || ctx.callback_query.from || ctx.callback_query.user;
    if (sender?.user_id) return sender.user_id;
    if (sender?.id) return sender.id;
  }
  
  // Прямой доступ к user_id
  if (ctx.user_id) return ctx.user_id;
  if (ctx.user?.user_id) return ctx.user.user_id;
  if (ctx.user?.id) return ctx.user.id;
  
  log('WARN', 'Could not get user ID from context', { 
    hasSender: !!ctx.sender,
    hasFrom: !!ctx.from,
    hasMessage: !!ctx.message,
    hasCallbackQuery: !!ctx.callback_query,
  });
  
  return null;
}

function getUserData(ctx: any): any {
  let sender = ctx.sender || ctx.from || ctx.message?.sender;
  if (ctx.callback_query) {
    sender = ctx.callback_query.sender || ctx.callback_query.from || sender;
  }
  return {
    username: sender?.username || '',
    firstName: sender?.first_name || sender?.name || '',
    lastName: sender?.last_name || '',
  };
}

// ============== BOT STARTED ==============

bot.on('bot_started', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `bot_started event, userId: ${id}`);

  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

// ============== COMMANDS ==============

bot.command('start', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/start command, userId: ${id}`);

  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

bot.command('patient', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  ctx.reply(PATIENT_MENU_MESSAGE, { attachments: [PatientKeyboard] });
});

bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/waitlist command, userId: ${id}`);
  
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `User ${id} has no consent, showing consent message`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `User ${id} starting waitlist flow`);
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_START', id);
  ctx.reply('Напишите имя:', { attachments: [CancelKeyboard] });
});

bot.command('order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  ctx.reply(ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/question command, userId: ${id}`);
  
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `User ${id} has no consent, showing consent message`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `User ${id} starting question flow`);
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_START', id);
  ctx.reply('Напишите ваше имя:', { attachments: [CancelKeyboard] });
});

bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `/feldsher command, userId: ${id}`);
  
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `User ${id} has no consent, showing consent message`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `User ${id} starting feldsher flow`);
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_START', id);
  ctx.reply('Как вас зовут?', { attachments: [CancelKeyboard] });
});

bot.command('doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  ctx.reply(DOVEREN_MESSAGE, { attachments: [BackKeyboard] });
});

bot.command('podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  ctx.reply(PODDERZHKA_MESSAGE, { attachments: [PodderzhkaKeyboard] });
});

bot.command('revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));
  await setUserState(id, 'revoke', 'confirm', {});
  ctx.reply(REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  ctx.reply(PRIVACY_MESSAGE, { attachments: [PrivacyKeyboard] });
});

bot.command('channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  ctx.reply(CHANNELS_MESSAGE, { attachments: [ChannelsKeyboard] });
});

bot.command('admin_stats', async (ctx) => {
  const id = getUserId(ctx);
  if (!id || !isAdmin(id)) {
    return ctx.reply('⛔ Доступ запрещён.');
  }
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

// ============== CALLBACK HANDLERS ==============

// Согласие
bot.action('consent_yes', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `consent_yes callback, userId: ${id}`);
  
  if (!id) return;

  await getOrCreateUser(id, getUserData(ctx));
  await setUserConsent(id, true);
  securityLog('CONSENT_GRANTED', id);
  
  await ctx.reply('✅ Спасибо за согласие! Теперь вы можете пользоваться ботом.', { attachments: [MainKeyboard] });
});

bot.action('consent_no', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `consent_no callback, userId: ${id}`);
  
  if (!id) return;
  
  securityLog('CONSENT_DENIED', id);
  await ctx.reply('❌ Без согласия функционал бота недоступен. Напишите /start чтобы попробовать снова.');
});

// Главное меню
bot.action('main_menu', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `main_menu callback, userId: ${id}`);
  
  if (!id) return;
  
  await clearUserState(id);
  await ctx.reply(WELCOME_MESSAGE, { attachments: [MainKeyboard] });
});

// Отмена
bot.action('cancel_flow', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `cancel_flow callback, userId: ${id}`);
  
  if (!id) return;
  
  await clearUserState(id);
  await ctx.reply('❌ Отменено.', { attachments: [MainKeyboard] });
});

// ========== MENU PATIENT ==========
bot.action('menu_patient', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_patient callback, userId: ${id}`);
  
  if (!id) {
    log('ERROR', 'menu_patient: could not get user ID');
    return;
  }

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `menu_patient: user ${id} has no consent`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  await clearUserState(id);
  await ctx.reply(PATIENT_MENU_MESSAGE, { attachments: [PatientKeyboard] });
});

// ========== PATIENT WAITLIST ==========
bot.action('patient_waitlist', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `patient_waitlist callback, userId: ${id}`);
  
  if (!id) {
    log('ERROR', 'patient_waitlist: could not get user ID');
    return;
  }

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `patient_waitlist: user ${id} has no consent`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `Starting waitlist flow for user ${id}`);
  await setUserState(id, 'waitlist', 'name', {});
  securityLog('WAITLIST_START', id);
  await ctx.reply('Напишите имя:', { attachments: [CancelKeyboard] });
});

bot.action('patient_order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await ctx.reply(ORDER_MESSAGE, { attachments: [BackKeyboard] });
});

// ========== MENU QUESTION ==========
bot.action('menu_question', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_question callback, userId: ${id}`);
  
  if (!id) {
    log('ERROR', 'menu_question: could not get user ID');
    return;
  }

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `menu_question: user ${id} has no consent`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  await clearUserState(id);
  await ctx.reply(QUESTION_MENU_MESSAGE, { attachments: [QuestionKeyboard] });
});

// ========== QUESTION ASK ==========
bot.action('question_ask', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `question_ask callback, userId: ${id}`);
  
  if (!id) {
    log('ERROR', 'question_ask: could not get user ID');
    return;
  }

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `question_ask: user ${id} has no consent`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `Starting question flow for user ${id}`);
  await setUserState(id, 'question', 'name', {});
  securityLog('QUESTION_START', id);
  await ctx.reply('Напишите ваше имя:', { attachments: [CancelKeyboard] });
});

// ========== MENU FELDSHER ==========
bot.action('menu_feldsher', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `menu_feldsher callback, userId: ${id}`);
  
  if (!id) {
    log('ERROR', 'menu_feldsher: could not get user ID');
    return;
  }

  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    log('INFO', `menu_feldsher: user ${id} has no consent`);
    return ctx.reply(CONSENT_MESSAGE, { attachments: [ConsentKeyboard] });
  }

  log('INFO', `Starting feldsher flow for user ${id}`);
  await setUserState(id, 'feldsher', 'name', {});
  securityLog('FELDSHER_START', id);
  await ctx.reply('Как вас зовут?', { attachments: [CancelKeyboard] });
});

// ========== INFO PAGES ==========
bot.action('menu_doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await ctx.reply(DOVEREN_MESSAGE, { attachments: [BackKeyboard] });
});

bot.action('menu_podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await ctx.reply(PODDERZHKA_MESSAGE, { attachments: [PodderzhkaKeyboard] });
});

bot.action('menu_privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await ctx.reply(PRIVACY_MESSAGE, { attachments: [PrivacyKeyboard] });
});

bot.action('menu_channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await ctx.reply(CHANNELS_MESSAGE, { attachments: [ChannelsKeyboard] });
});

// ========== REVOKE ==========
bot.action('menu_revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await setUserState(id, 'revoke', 'confirm', {});
  await ctx.reply(REVOKE_MESSAGE, { attachments: [RevokeKeyboard] });
});

bot.action('revoke_yes', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await deleteAllUserData(id);
  securityLog('DATA_DELETED', id);
  log('INFO', `User ${id} revoked consent and deleted data`);
  await ctx.reply('🗑️ Ваши данные удалены. Для использования бота напишите /start и примите согласие заново.');
});

bot.action('revoke_no', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await ctx.reply('✅ Данные сохранены.', { attachments: [MainKeyboard] });
});

// ========== DISTRICT SELECTION ==========
bot.action(/district_(\d)/, async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `district callback, userId: ${id}, match: ${ctx.match}`);
  
  if (!id) return;

  const districtId = ctx.match?.[1];
  const district = BOT_CONFIG.districts.find(d => d.id === districtId);

  if (!district) {
    return ctx.reply('Ошибка выбора района.', { attachments: getDistrictKeyboard() });
  }

  const state = await getUserState(id);
  if (!state || state.flowType !== 'waitlist') {
    return ctx.reply('Ошибка. Начните заново через /waitlist', { attachments: [MainKeyboard] });
  }

  const stateData = state.data;
  stateData.district = district.name;
  await setUserState(id, 'waitlist', 'preview', stateData);

  const preview = `📋 Проверьте ваши данные:

👤 Имя: ${escapeHtml(stateData.name)}
📞 Телефон: ${escapeHtml(stateData.phone)}
📍 Район: ${escapeHtml(stateData.district)}`;

  await ctx.reply(preview, { attachments: [ConfirmKeyboard] });
});

// ========== SCHEDULE SELECTION ==========
bot.action('schedule_16', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_16 callback, userId: ${id}`);
  
  if (!id) return;

  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') {
    return ctx.reply('Ошибка. Начните заново через /feldsher', { attachments: [MainKeyboard] });
  }

  const stateData = state.data;
  stateData.scheduleType = '16 смен (основной фельдшер)';
  await setUserState(id, 'feldsher', 'resume', stateData);

  await ctx.reply('Ссылка на ваше резюме или опишите свой опыт кратко в произвольной форме:', { attachments: [CancelKeyboard] });
});

bot.action('schedule_12', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `schedule_12 callback, userId: ${id}`);
  
  if (!id) return;

  const state = await getUserState(id);
  if (!state || state.flowType !== 'feldsher') {
    return ctx.reply('Ошибка. Начните заново через /feldsher', { attachments: [MainKeyboard] });
  }

  const stateData = state.data;
  stateData.scheduleType = '12 смен (воскресный фельдшер)';
  await setUserState(id, 'feldsher', 'resume', stateData);

  await ctx.reply('Ссылка на ваше резюме или опишите свой опыт кратко в произвольной форме:', { attachments: [CancelKeyboard] });
});

// ========== CONFIRM SEND ==========
bot.action('confirm_send', async (ctx) => {
  const id = getUserId(ctx);
  log('INFO', `confirm_send callback, userId: ${id}`);
  
  if (!id) return;

  const state = await getUserState(id);
  if (!state) {
    return ctx.reply('Ошибка. Начните заново.', { attachments: [MainKeyboard] });
  }

  const stateData = state.data;

  try {
    if (state.flowType === 'waitlist') {
      await saveWaitlistEntry(id, stateData);
      await sendNotification('waitlist', stateData);
      securityLog('WAITLIST_SAVED', id, { district: stateData.district });
      await clearUserState(id);
      return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}. Вы добавлены в лист ожидания.`, { attachments: [BackKeyboard] });
    }

    if (state.flowType === 'question') {
      await saveQuestion(id, stateData);
      await sendNotification('question', stateData);
      securityLog('QUESTION_SAVED', id);
      await clearUserState(id);
      return ctx.reply(`✅ Спасибо за вопрос. Мы получили его и свяжемся с вами в ближайшее время.`, { attachments: [BackKeyboard] });
    }

    if (state.flowType === 'feldsher') {
      await saveFeldsherApplication(id, stateData);
      await sendNotification('feldsher', stateData);
      securityLog('FELDSHER_SAVED', id);
      await clearUserState(id);
      return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}. Мы получили вашу анкету и свяжемся с вами в ближайшее время для назначения собеседования.`, { attachments: [BackKeyboard] });
    }

    await clearUserState(id);
    await ctx.reply('Ошибка. Начните заново.', { attachments: [MainKeyboard] });
  } catch (e) {
    log('ERROR', 'Failed to save data', e);
    await ctx.reply('Ошибка сохранения. Попробуйте позже.', { attachments: [MainKeyboard] });
  }
});

bot.action('confirm_cancel', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await clearUserState(id);
  await ctx.reply('❌ Данные не отправлены.', { attachments: [MainKeyboard] });
});

// ============== TEXT MESSAGE HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text;

  log('INFO', `message_created, userId: ${id}, text: ${text}`);

  if (!id || !text) return;

  // Проверка согласия
  const hasConsent = await hasUserConsent(id);
  log('INFO', `User ${id} consent status: ${hasConsent}`);
  
  if (!hasConsent) {
    await ctx.reply('Пожалуйста, используйте кнопки для выбора.', { attachments: [ConsentKeyboard] });
    return;
  }

  const state = await getUserState(id);
  log('INFO', `User ${id} state:`, state);
  
  const sanitizedText = sanitizeInput(text, state?.flowType === 'question' && state?.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);

  if (!state) {
    await ctx.reply('Пожалуйста, используйте кнопки меню.', { attachments: [MainKeyboard] });
    return;
  }

  const stateData = state.data;

  // ========== WAITLIST FLOW ==========
  if (state.flowType === 'waitlist') {
    log('INFO', `Waitlist flow, step: ${state.currentStep}`);
    
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'waitlist', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9ххххххххх):', { attachments: [CancelKeyboard] });
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9ххххххххх:', { attachments: [CancelKeyboard] });
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'waitlist', 'district', stateData);
      return ctx.reply('Выберите кнопкой предпочтительный район обслуживания:', { attachments: getDistrictKeyboard() });
    }
  }

  // ========== FELDSHER FLOW ==========
  if (state.flowType === 'feldsher') {
    log('INFO', `Feldsher flow, step: ${state.currentStep}`);
    
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'feldsher', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9ххххххххх):', { attachments: [CancelKeyboard] });
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9ххххххххх:', { attachments: [CancelKeyboard] });
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'feldsher', 'experience', stateData);
      return ctx.reply('Общий стаж работы фельдшером (лет):', { attachments: [CancelKeyboard] });
    }
    if (state.currentStep === 'experience') {
      if (!validateExperience(sanitizedText)) {
        return ctx.reply('Пожалуйста, введите стаж цифрой (например: 5):', { attachments: [CancelKeyboard] });
      }
      stateData.experience = sanitizedText.replace(/\D/g, '');
      await setUserState(id, 'feldsher', 'schedule', stateData);
      return ctx.reply('Какой график вы предпочитаете?', { attachments: [ScheduleKeyboard] });
    }
    if (state.currentStep === 'resume') {
      stateData.resumeLink = sanitizedText;
      await setUserState(id, 'feldsher', 'preview', stateData);

      const preview = `👨‍⚕️ Проверьте ваши данные:

👤 Имя: ${escapeHtml(stateData.name)}
📞 Телефон: ${escapeHtml(stateData.phone)}
⏳ Стаж: ${escapeHtml(stateData.experience)}
📅 График: ${escapeHtml(stateData.scheduleType)}
📎 Резюме: ${escapeHtml(stateData.resumeLink)}`;

      return ctx.reply(preview, { attachments: [ConfirmKeyboard] });
    }
  }

  // ========== QUESTION FLOW ==========
  if (state.flowType === 'question') {
    log('INFO', `Question flow, step: ${state.currentStep}`);
    
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'question', 'phone', stateData);
      return ctx.reply('Напишите ваш номер телефона для связи (в формате: +7-9ххххххххх), чтобы мы могли вам ответить:', { attachments: [CancelKeyboard] });
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9ххххххххх:', { attachments: [CancelKeyboard] });
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'question', 'question', stateData);
      return ctx.reply('Задайте ваш вопрос о будущем или действующем кабинете. Мы ответим вам в ближайшее время.', { attachments: [CancelKeyboard] });
    }
    if (state.currentStep === 'question') {
      stateData.question = sanitizedText;
      await setUserState(id, 'question', 'preview', stateData);

      const preview = `❓ Проверьте ваши данные:

👤 Имя: ${escapeHtml(stateData.name)}
📞 Телефон: ${escapeHtml(stateData.phone)}
💬 Вопрос: ${escapeHtml(stateData.question)}`;

      return ctx.reply(preview, { attachments: [ConfirmKeyboard] });
    }
  }

  await ctx.reply('Пожалуйста, используйте кнопки меню.', { attachments: [MainKeyboard] });
});

bot.catch((err) => {
  log('ERROR', 'Bot error', err);
  console.error('Bot error:', err);
});

// ============== HTTP SERVER ==============

async function startHttpServer(port: number) {
  const server = Bun.serve({
    port: port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          bot: 'FeldsherRyadomBot for MAX',
          version: '7.0',
          adminId: ADMIN_ID,
          channelId: CHANNEL_ID,
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
  console.log('🤖 FeldsherRyadomBot for MAX v7.0 starting...');
  console.log(`📋 Admin ID: ${ADMIN_ID}`);
  console.log(`📢 Channel ID: ${CHANNEL_ID}`);

  try {
    await prisma.$connect();
    log('INFO', 'Database connected');
    console.log('✅ Database connected');
  } catch (error) {
    log('ERROR', 'Database connection failed', error);
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }

  await startHttpServer(BOT_CONFIG.port);

  try {
    await bot.api.setMyCommands([
      { name: 'start', description: '🏠 Главное меню' },
      { name: 'patient', description: '📋 Пациенту' },
      { name: 'waitlist', description: '📋 Лист ожидания' },
      { name: 'order', description: '💰 Оплатить предзаказ' },
      { name: 'question', description: '❓ Задать вопрос' },
      { name: 'feldsher', description: '👨‍⚕️ Фельдшеру' },
      { name: 'doveren', description: '📄 Доверенность' },
      { name: 'podderzhka', description: '❤️ Поддержать' },
      { name: 'revoke', description: '🗑️ Отозвать согласие' },
      { name: 'privacy', description: '🔐 Свод правил' },
      { name: 'channels', description: '📢 Наши каналы' },
    ]);
    log('INFO', 'Bot commands set successfully');
    console.log('✅ Bot commands set');
  } catch (error) {
    log('WARN', 'Could not set bot commands', error);
    console.log('⚠️ Could not set bot commands');
  }

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
