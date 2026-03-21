#!/usr/bin/env bun
/**
 * MAX Messenger Bot for Feldsher.Ryadom project
 * Version: 4.0 - Button-only navigation (no text input for choices)
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
  scheduleOptions: {
    '1': '16 смен',
    '2': '12 смен',
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

const DISTRICT_MESSAGE = `📍 ВЫБОР РАЙОНА

В каком районе вы планируете посещать кабинет?`;

const SCHEDULE_MESSAGE = `📅 ВЫБОР ГРАФИКА

У нас сменный режим работы по 5 часов.

Вариант 1 (16 смен за 4 недели):
16 будничных дней (по 4 дня в неделю) – распределение смен: 5 утренних (07:00–12:00), 6 дневных (12:00–17:00), 5 вечерних (16:00–21:00).

Вариант 2 (12 смен за 4 недели):
1 утренняя + 1 вечерняя в будни; 1 дневная каждое воскресенье.

Какой формат вам подходит?`;

// ============== KEYBOARDS ==============

// Клавиатура согласия
function getConsentKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('✅ Согласен (-на)', 'consent_yes')],
    [Keyboard.button.callback('❌ Не согласен (-на)', 'consent_no')],
  ]);
}

// Главное меню
function getMainKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('📋 Пациентам', 'menu_patient')],
    [Keyboard.button.callback('❓ У меня есть вопрос', 'menu_question')],
    [Keyboard.button.callback('👨‍⚕️ Фельдшеру – отправить резюме', 'menu_feldsher')],
    [Keyboard.button.callback('📄 Текст доверенности', 'menu_doveren')],
    [Keyboard.button.callback('❤️ Поддержать проект', 'menu_podderzhka')],
    [Keyboard.button.callback('🗑️ Отозвать согласие', 'menu_revoke')],
    [Keyboard.button.callback('🔐 Свод правил', 'menu_privacy')],
    [Keyboard.button.callback('📢 Наши каналы', 'menu_channels')],
  ]);
}

// Меню пациента
function getPatientKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('📋 Лист ожидания', 'patient_waitlist')],
    [Keyboard.button.callback('💰 Оплатить предзаказ', 'patient_order')],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Меню вопросов
function getQuestionKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('❓ Задать вопрос', 'question_ask')],
    [Keyboard.button.callback('🗑️ Отозвать согласие', 'menu_revoke')],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Клавиатура отмены
function getCancelKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('❌ Отменить', 'cancel_flow')],
  ]);
}

// Клавиатура отмены + главное меню
function getCancelMenuKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('❌ Отменить', 'cancel_flow')],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Выбор района
function getDistrictKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('1. Индустриальный', 'district_1')],
    [Keyboard.button.callback('2. Ленинский', 'district_2')],
    [Keyboard.button.callback('3. Октябрьский', 'district_3')],
    [Keyboard.button.callback('4. Первомайский', 'district_4')],
    [Keyboard.button.callback('5. Устиновский', 'district_5')],
    [Keyboard.button.callback('❌ Отменить', 'cancel_flow')],
  ]);
}

// Выбор графика
function getScheduleKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('Вариант 1 (16 смен)', 'schedule_1')],
    [Keyboard.button.callback('Вариант 2 (12 смен)', 'schedule_2')],
    [Keyboard.button.callback('❌ Отменить', 'cancel_flow')],
  ]);
}

// Подтверждение отзыва
function getRevokeKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('✅ Да, удалить мои данные', 'revoke_yes')],
    [Keyboard.button.callback('❌ Нет, я передумал', 'revoke_no')],
  ]);
}

// Клавиатура возврата в меню
function getBackKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Клавиатура с каналами
function getChannelsKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.link('🟪 MAX (пациентам)', BOT_CONFIG.patientChannelLink)],
    [Keyboard.button.link('🟪 MAX (фельдшерам)', BOT_CONFIG.feldsherChannelLink)],
    [Keyboard.button.link('🔵 VK (пациентам)', BOT_CONFIG.vkPatientLink)],
    [Keyboard.button.link('🔵 VK (фельдшерам)', BOT_CONFIG.vkFeldsherLink)],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Клавиатура поддержки
function getPodderzhkaKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.link('💰 Планета.ру', BOT_CONFIG.planetaLink)],
    [Keyboard.button.link('💳 Сбер', BOT_CONFIG.sberLink)],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// Клавиатура с политикой
function getPrivacyKeyboard() {
  return Keyboard.inline([
    [Keyboard.button.link('📄 Политика конфиденциальности', BOT_CONFIG.privacyLink)],
    [Keyboard.button.callback('🏠 Главное меню', 'main_menu')],
  ]);
}

// ============== HELPER ==============

function getUserId(ctx: any): number | null {
  const sender = ctx.sender || ctx.from || ctx.message?.sender || ctx.callback_query?.sender;
  if (sender?.user_id) return sender.user_id;
  if (sender?.id) return sender.id;
  return null;
}

function getUserData(ctx: any): any {
  const sender = ctx.sender || ctx.from || ctx.message?.sender || ctx.callback_query?.sender;
  return {
    username: sender?.username || '',
    firstName: sender?.first_name || sender?.name || '',
    lastName: sender?.last_name || '',
  };
}

// ============== CALLBACK HANDLERS ==============

// Согласие
bot.on('callback_query', async (ctx: any) => {
  const id = getUserId(ctx);
  const callbackId = ctx.callback_query?.callback_id || ctx.callbackId;
  const payload = ctx.callback_query?.payload || ctx.payload;

  if (!id || !payload) return;

  log('INFO', `Callback from user ${id}: ${payload}`);

  try {
    // ========== CONSENT ==========
    if (payload === 'consent_yes') {
      await getOrCreateUser(id, getUserData(ctx));
      await setUserConsent(id, true);
      securityLog('CONSENT_GRANTED', id);
      await ctx.reply('✅ Спасибо за согласие! Теперь вы можете пользоваться ботом.', getMainKeyboard());
      return;
    }

    if (payload === 'consent_no') {
      securityLog('CONSENT_DENIED', id);
      await ctx.reply('❌ Без согласия функционал бота недоступен. Напишите /start чтобы попробовать снова.');
      return;
    }

    // Проверка согласия для остальных действий
    if (!(await hasUserConsent(id))) {
      await ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
      return;
    }

    // ========== MAIN MENU ==========
    if (payload === 'main_menu') {
      await clearUserState(id);
      await ctx.reply(WELCOME_MESSAGE, getMainKeyboard());
      return;
    }

    // ========== CANCEL ==========
    if (payload === 'cancel_flow') {
      await clearUserState(id);
      await ctx.reply('❌ Отменено.', getMainKeyboard());
      return;
    }

    // ========== PATIENT MENU ==========
    if (payload === 'menu_patient') {
      await clearUserState(id);
      await ctx.reply(PATIENT_MENU_MESSAGE, getPatientKeyboard());
      return;
    }

    if (payload === 'patient_waitlist') {
      await setUserState(id, 'waitlist', 'name', {});
      securityLog('WAITLIST_START', id);
      await ctx.reply('Напишите ваше имя:', getCancelKeyboard());
      return;
    }

    if (payload === 'patient_order') {
      await ctx.reply(ORDER_MESSAGE, getBackKeyboard());
      return;
    }

    // ========== QUESTION MENU ==========
    if (payload === 'menu_question') {
      await clearUserState(id);
      await ctx.reply(QUESTION_MENU_MESSAGE, getQuestionKeyboard());
      return;
    }

    if (payload === 'question_ask') {
      await setUserState(id, 'question', 'name', {});
      securityLog('QUESTION_START', id);
      await ctx.reply('Напишите ваше имя:', getCancelKeyboard());
      return;
    }

    // ========== FELDSHER ==========
    if (payload === 'menu_feldsher') {
      await setUserState(id, 'feldsher', 'name', {});
      securityLog('FELDSHER_START', id);
      await ctx.reply('Как вас зовут?', getCancelKeyboard());
      return;
    }

    // ========== DISTRICT SELECTION ==========
    if (payload.startsWith('district_')) {
      const districtId = payload.replace('district_', '');
      const district = BOT_CONFIG.districts.find(d => d.id === districtId);

      if (!district) {
        await ctx.reply('Ошибка выбора района. Попробуйте снова.', getDistrictKeyboard());
        return;
      }

      const state = await getUserState(id);
      if (!state || state.flowType !== 'waitlist') {
        await ctx.reply('Ошибка. Начните заново.', getMainKeyboard());
        return;
      }

      const stateData = state.data;
      stateData.district = district.name;

      try {
        await saveWaitlistEntry(id, stateData);
        await sendNotification('waitlist', stateData);
        securityLog('WAITLIST_SAVED', id, { district: district.name });
        await clearUserState(id);
        await ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Вы добавлены в лист ожидания.

Как только откроем фельдшерский кабинет, мы свяжемся с вами.`, getBackKeyboard());
      } catch (e) {
        log('ERROR', 'Failed to save waitlist', e);
        await ctx.reply('Ошибка сохранения. Попробуйте позже.', getMainKeyboard());
      }
      return;
    }

    // ========== SCHEDULE SELECTION ==========
    if (payload.startsWith('schedule_')) {
      const scheduleId = payload.replace('schedule_', '');
      const scheduleName = BOT_CONFIG.scheduleOptions[scheduleId as keyof typeof BOT_CONFIG.scheduleOptions];

      if (!scheduleName) {
        await ctx.reply('Ошибка выбора графика. Попробуйте снова.', getScheduleKeyboard());
        return;
      }

      const state = await getUserState(id);
      if (!state || state.flowType !== 'feldsher') {
        await ctx.reply('Ошибка. Начните заново.', getMainKeyboard());
        return;
      }

      const stateData = state.data;
      stateData.scheduleType = scheduleName;
      await setUserState(id, 'feldsher', 'resume', stateData);

      await ctx.reply('Ссылка на резюме (Google Docs, hh.ru) или краткое описание опыта. Если нет резюме, напишите "нет":', getCancelKeyboard());
      return;
    }

    // ========== REVOKE ==========
    if (payload === 'menu_revoke') {
      await setUserState(id, 'revoke', 'confirm', {});
      await ctx.reply(REVOKE_MESSAGE, getRevokeKeyboard());
      return;
    }

    if (payload === 'revoke_yes') {
      await deleteAllUserData(id);
      securityLog('DATA_DELETED', id);
      log('INFO', `User ${id} revoked consent and deleted data`);
      await ctx.reply('🗑️ Ваши данные удалены. Для использования бота напишите /start и примите согласие заново.');
      return;
    }

    if (payload === 'revoke_no') {
      await clearUserState(id);
      await ctx.reply('✅ Данные сохранены.', getMainKeyboard());
      return;
    }

    // ========== INFO PAGES ==========
    if (payload === 'menu_doveren') {
      await ctx.reply(DOVEREN_MESSAGE, getBackKeyboard());
      return;
    }

    if (payload === 'menu_podderzhka') {
      await ctx.reply(PODDERZHKA_MESSAGE, getPodderzhkaKeyboard());
      return;
    }

    if (payload === 'menu_privacy') {
      await ctx.reply(PRIVACY_MESSAGE, getPrivacyKeyboard());
      return;
    }

    if (payload === 'menu_channels') {
      await ctx.reply(CHANNELS_MESSAGE, getChannelsKeyboard());
      return;
    }

  } catch (error) {
    log('ERROR', 'Callback handler error', error);
    console.error('Callback error:', error);
  }
});

// ============== BOT STARTED ==============

bot.on('bot_started', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  log('INFO', `User ${id} started bot (bot_started event)`);
  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }

  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE, getMainKeyboard());
});

// ============== COMMANDS ==============

bot.command('start', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;

  log('INFO', `User ${id} used /start command`);
  await getOrCreateUser(id, getUserData(ctx));

  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }

  await clearUserState(id);
  ctx.reply(WELCOME_MESSAGE, getMainKeyboard());
});

bot.command('patient', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  ctx.reply(PATIENT_MENU_MESSAGE, getPatientKeyboard());
});

bot.command('waitlist', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  await setUserState(id, 'waitlist', 'name', {});
  ctx.reply('Напишите ваше имя:', getCancelKeyboard());
});

bot.command('order', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  ctx.reply(ORDER_MESSAGE, getBackKeyboard());
});

bot.command('question', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  ctx.reply(QUESTION_MENU_MESSAGE, getQuestionKeyboard());
});

bot.command('feldsher', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  await setUserState(id, 'feldsher', 'name', {});
  ctx.reply('Как вас зовут?', getCancelKeyboard());
});

bot.command('doveren', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  ctx.reply(DOVEREN_MESSAGE, getBackKeyboard());
});

bot.command('podderzhka', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  if (!(await hasUserConsent(id))) {
    return ctx.reply(CONSENT_MESSAGE, getConsentKeyboard());
  }
  ctx.reply(PODDERZHKA_MESSAGE, getPodderzhkaKeyboard());
});

bot.command('revoke', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  await getOrCreateUser(id, getUserData(ctx));
  await setUserState(id, 'revoke', 'confirm', {});
  ctx.reply(REVOKE_MESSAGE, getRevokeKeyboard());
});

bot.command('privacy', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  ctx.reply(PRIVACY_MESSAGE, getPrivacyKeyboard());
});

bot.command('channels', async (ctx) => {
  const id = getUserId(ctx);
  if (!id) return;
  ctx.reply(CHANNELS_MESSAGE, getChannelsKeyboard());
});

// Admin commands
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

// ============== TEXT MESSAGE HANDLER ==============

bot.on('message_created', async (ctx) => {
  const id = getUserId(ctx);
  const text = ctx.message?.body?.text || ctx.message?.text;

  if (!id || !text) return;

  log('INFO', `Message from user ${id}: ${text}`);

  // Если нет согласия - показываем consent
  if (!(await hasUserConsent(id))) {
    await ctx.reply('Пожалуйста, используйте кнопки для выбора.', getConsentKeyboard());
    return;
  }

  const state = await getUserState(id);
  const sanitizedText = sanitizeInput(text, state?.flowType === 'question' && state?.currentStep === 'question' ? MAX_QUESTION_LENGTH : MAX_INPUT_LENGTH);

  // Если нет состояния - показываем главное меню
  if (!state) {
    await ctx.reply('Пожалуйста, используйте кнопки меню.', getMainKeyboard());
    return;
  }

  const stateData = state.data;

  // ========== WAITLIST FLOW ==========
  if (state.flowType === 'waitlist') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'waitlist', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9xx-xxx-xx-xx):', getCancelKeyboard());
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9xx-xxx-xx-xx:', getCancelKeyboard());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'waitlist', 'district', stateData);
      return ctx.reply(DISTRICT_MESSAGE, getDistrictKeyboard());
    }
  }

  // ========== FELDSHER FLOW ==========
  if (state.flowType === 'feldsher') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'feldsher', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9xx-xxx-xx-xx):', getCancelKeyboard());
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9xx-xxx-xx-xx:', getCancelKeyboard());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'feldsher', 'experience', stateData);
      return ctx.reply('Ваш стаж работы (лет):', getCancelKeyboard());
    }
    if (state.currentStep === 'experience') {
      stateData.experience = sanitizedText;
      await setUserState(id, 'feldsher', 'schedule', stateData);
      return ctx.reply(SCHEDULE_MESSAGE, getScheduleKeyboard());
    }
    if (state.currentStep === 'resume') {
      stateData.resumeLink = sanitizedText.toLowerCase() === 'нет' ? '' : sanitizedText;
      try {
        await saveFeldsherApplication(id, stateData);
        await sendNotification('feldsher', stateData);
        securityLog('FELDSHER_SAVED', id);
        await clearUserState(id);
        return ctx.reply(`✅ Спасибо, ${escapeHtml(stateData.name)}! Ваша анкета передана администратору.
Мы свяжемся с вами в ближайшее время.`, getBackKeyboard());
      } catch (e) {
        log('ERROR', 'Failed to save feldsher application', e);
        return ctx.reply('Ошибка сохранения. Попробуйте позже.', getMainKeyboard());
      }
    }
  }

  // ========== QUESTION FLOW ==========
  if (state.flowType === 'question') {
    if (state.currentStep === 'name') {
      stateData.name = sanitizedText;
      await setUserState(id, 'question', 'phone', stateData);
      return ctx.reply('Ваш номер телефона (в формате: +7-9xx-xxx-xx-xx):', getCancelKeyboard());
    }
    if (state.currentStep === 'phone') {
      if (!validatePhone(sanitizedText)) {
        return ctx.reply('Неверный формат телефона. Введите номер в формате +7-9xx-xxx-xx-xx:', getCancelKeyboard());
      }
      stateData.phone = formatPhone(sanitizedText);
      await setUserState(id, 'question', 'question', stateData);
      return ctx.reply('Напишите ваш вопрос о проекте или кабинете:', getCancelKeyboard());
    }
    if (state.currentStep === 'question') {
      stateData.question = sanitizedText;
      try {
        await saveQuestion(id, stateData);
        await sendNotification('question', stateData);
        securityLog('QUESTION_SAVED', id);
        await clearUserState(id);
        return ctx.reply(`✅ Спасибо за вопрос, ${escapeHtml(stateData.name)}! Мы получили его и свяжемся с вами в ближайшее время.`, getBackKeyboard());
      } catch (e) {
        log('ERROR', 'Failed to save question', e);
        return ctx.reply('Ошибка сохранения. Попробуйте позже.', getMainKeyboard());
      }
    }
  }

  // Если состояние не распознано
  await ctx.reply('Пожалуйста, используйте кнопки меню.', getMainKeyboard());
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
          version: '4.0',
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
  console.log('🤖 FeldsherRyadomBot for MAX v4.0 starting...');
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
