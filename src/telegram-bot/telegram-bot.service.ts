import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { Telegraf, Context, Markup } from 'telegraf';
import { Vacancy } from '../database/vacancy.entity';
import { UserbotService } from '../userbot/userbot.service';
import { MetricsService } from '../metrics/metrics.service';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(TelegramBotService.name);
	private bot?: Telegraf;
	private readonly allowedUsers: number[] = [];
	private readonly botToken?: string;

  constructor(
		private readonly configService: ConfigService,
		@InjectRepository(Vacancy)
    private readonly vacancyRepository: Repository<Vacancy>,
    private readonly userbotService: UserbotService,
    private readonly metricsService: MetricsService,
  ) {
		this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
		const allowedUsersStr = this.configService.get<string>('TELEGRAM_BOT_ALLOWED_USERS');
		if (allowedUsersStr) {
			this.allowedUsers = allowedUsersStr
				.split(/[,\s]+/)
				.map((id) => Number(id.trim()))
				.filter((id) => Number.isFinite(id) && id > 0);
		}
	}

	async onModuleInit(): Promise<void> {
		this.logger.log('onModuleInit called');
		if (!this.botToken) {
			this.logger.warn('Telegram bot token not configured (TELEGRAM_BOT_TOKEN missing); skipping');
			return;
		}

		this.logger.log(`Initializing Telegram bot with token: ${this.botToken.substring(0, 10)}...`);
		try {
			this.bot = new Telegraf(this.botToken);
			this.logger.log('Telegraf instance created');
			
			// Note: We skip getMe() check as it may fail in Docker due to network/DNS issues
			// but the bot itself will work fine. The token is validated during launch.
			
			this.logger.log('Setting up commands...');
			this.setupCommands();
			this.logger.log('Commands setup complete');
			
			// Add error handler before launch
			this.bot.catch((err: unknown, ctx: Context) => {
				this.logger.error(`Telegram bot error: ${(err as Error).message}`, (err as Error).stack);
				if (ctx) {
					ctx.reply('Произошла ошибка при обработке запроса').catch(() => {});
				}
			});
			
			this.logger.log('Launching bot...');
			// Launch bot with polling (default mode)
			// Note: bot.launch() starts polling and runs indefinitely, so we don't await it
			// Instead, we launch it and let it run in the background
			this.bot.launch().then(() => {
				this.logger.log(`✅ Telegram bot started successfully. Allowed users: ${this.allowedUsers.length > 0 ? this.allowedUsers.join(', ') : 'ALL'}`);
			}).catch((err: unknown) => {
				this.logger.error(`❌ Error after bot launch: ${(err as Error).message}`, (err as Error).stack);
			});
			
			// Give bot a moment to start
			await new Promise(resolve => setTimeout(resolve, 2000));
			this.logger.log('Bot launch initiated (polling started)');
		} catch (error: unknown) {
			this.logger.error(`❌ Failed to start Telegram bot: ${(error as Error).message}`, (error as Error).stack);
		}
	}

	onModuleDestroy(): void {
		if (this.bot) {
			this.bot.stop('NestJS shutdown');
		}
	}

	private isUserAllowed(userId: number): boolean {
		if (this.allowedUsers.length === 0) return true;
		return this.allowedUsers.includes(userId);
	}

	// Главное меню (reply keyboard)
	private getMainMenu() {
		return Markup.keyboard([
			['📋 Список вакансий', '📊 Статистика'],
			['🔍 Поиск', '🕐 Последние'],
			['📎 Загрузить CV', '❓ Помощь']
		]).resize();
	}

	private setupCommands(): void {
		if (!this.bot) return;

		// Middleware для проверки доступа
		this.bot.use(async (ctx: Context, next) => {
			const userId = ctx.from?.id;
			if (!userId) {
				await ctx.reply('Ошибка: не удалось определить пользователя');
				return;
			}
			if (!this.isUserAllowed(userId)) {
				await ctx.reply('❌ У вас нет доступа к этому боту');
				return;
			}
			await next();
		});

		// Upload CV: prompt
		this.bot.hears('📎 Загрузить CV', async (ctx: Context) => {
			await ctx.reply('Пришлите ваш файл CV (PDF/DOC/DOCX). Я сохраню его и буду прикладывать к откликам.');
		});

		// Handle document upload
		this.bot.on('document', async (ctx: Context) => {
			try {
				const doc = (ctx.message as any)?.document;
				if (!doc) return;
				const fileId = doc.file_id as string;
				const fileName = (doc.file_name as string) || `cv_${ctx.from?.id || 'user'}`;
				const link = await ctx.telegram.getFileLink(fileId);
				// Download to local storage
				const dir = 'data/cv';
				await (await import('fs/promises')).mkdir(dir, { recursive: true });
				const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
				const savePath = `${dir}/${ctx.from?.id || 'user'}_${safeName}`;
				const res = await fetch(link.href);
				if (!res.ok) throw new Error(`download failed: ${res.status}`);
				const buf = Buffer.from(await res.arrayBuffer());
				await (await import('fs/promises')).writeFile(savePath, buf);
				this.userbotService.setCvFilePath(savePath);
				await ctx.reply('✅ CV сохранён. Теперь кнопка "📎 Отправить CV" будет прикладывать файл к сообщению.');
			} catch (e: unknown) {
				await ctx.reply(`❌ Не удалось сохранить CV: ${(e as Error).message}`);
			}
		});

		// /start
		this.bot.command('start', async (ctx: Context) => {
			this.metricsService.telegramBotCommandsTotal.inc({ command: 'start' });
			await ctx.reply(
				'👋 Привет! Я бот для управления вакансиями.\n\n' +
				'Используйте кнопки меню ниже для навигации.',
				this.getMainMenu(),
			);
		});

		// Обработка текстовых команд из меню
		this.bot.hears('📋 Список вакансий', async (ctx: Context) => {
			await this.showList(ctx, undefined);
		});

		this.bot.hears('📊 Статистика', async (ctx: Context) => {
			await this.showStats(ctx);
		});

		this.bot.hears('🔍 Поиск', async (ctx: Context) => {
			await ctx.reply('🔍 Введите поисковый запрос. Например: DevOps, Kubernetes, Terraform', this.getMainMenu());
		});

		this.bot.hears('🕐 Последние', async (ctx: Context) => {
			await this.showRecent(ctx, 10);
		});

		this.bot.hears('❓ Помощь', async (ctx: Context) => {
			await this.showHelp(ctx);
		});

		// /help
		this.bot.command('help', async (ctx: Context) => {
			await this.showHelp(ctx);
		});

		// Обработка поискового запроса (если пользователь написал текст после выбора поиска)
		// Этот обработчик должен быть последним, чтобы не перехватывать команды и кнопки
		this.bot.on('text', async (ctx: Context) => {
			// Пропускаем команды и кнопки меню
			if (ctx.message && 'text' in ctx.message) {
				const text = ctx.message.text;
				if (text.startsWith('/')) return; // Команды обрабатываются отдельно
				if (['📋 Список вакансий', '📊 Статистика', '🔍 Поиск', '🕐 Последние', '❓ Помощь'].includes(text)) {
					return; // Кнопки меню обрабатываются отдельно
				}
				// Если это обычный текст (не команда и не кнопка) - считаем это поисковым запросом
				await this.showSearch(ctx, text);
			}
		});

		// /stats
		this.bot.command('stats', async (ctx: Context) => {
			this.metricsService.telegramBotCommandsTotal.inc({ command: 'stats' });
			await this.showStats(ctx);
		});

		// /list
		this.bot.command('list', async (ctx: Context) => {
			this.metricsService.telegramBotCommandsTotal.inc({ command: 'list' });
			const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
			const status = args[0] || undefined;
			await this.showList(ctx, status);
		});

		// /recent
		this.bot.command('recent', async (ctx: Context) => {
			this.metricsService.telegramBotCommandsTotal.inc({ command: 'recent' });
			const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
			const limit = args[0] ? Math.min(Number(args[0]) || 10, 50) : 10;
			await this.showRecent(ctx, limit);
		});

		// /search
		this.bot.command('search', async (ctx: Context) => {
			this.metricsService.telegramBotCommandsTotal.inc({ command: 'search' });
			const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
			const query = args.join(' ');
			
			if (!query) {
				await ctx.reply('🔍 Введите поисковый запрос. Например: DevOps, Kubernetes, Terraform', this.getMainMenu());
				return;
			}
			
			await this.showSearch(ctx, query);
		});

		// /vacancy <id>
		this.bot.command('vacancy', async (ctx: Context) => {
			try {
				const args = ctx.message && 'text' in ctx.message ? ctx.message.text.split(' ').slice(1) : [];
				const id = args[0];

				if (!id) {
					await ctx.reply('❌ Укажите ID вакансии. Пример: /vacancy <uuid> или короткий ID из списка', this.getMainMenu());
					return;
				}

				// Поиск по полному UUID или по началу UUID
				let vacancy = await this.vacancyRepository.findOne({ where: { id: id } });
				if (!vacancy && id.length < 36) {
					// Попробуем найти по началу UUID
					const allVacancies = await this.vacancyRepository.find({ take: 100 });
					vacancy = allVacancies.find((v) => v.id.startsWith(id)) ?? null;
				}

				if (!vacancy) {
					await ctx.reply(`❌ Вакансия с ID "${id}" не найдена. Используйте UUID или короткий ID из списка.`, this.getMainMenu());
					return;
				}

				await this.sendVacancyCard(ctx, vacancy, true);
			} catch (error: unknown) {
				await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
			}
		});

		// Обработка callback queries (инлайн-кнопки)
		this.bot.on('callback_query', async (ctx: Context) => {
			this.logger.log('🔔 Callback query event received');
			try {
				if (!ctx.callbackQuery) {
					this.logger.warn('Callback query missing ctx.callbackQuery');
					return;
				}
				if (!('data' in ctx.callbackQuery)) {
					this.logger.warn('Callback query missing data field');
					return;
				}
				
				const data = ctx.callbackQuery.data;
				const userId = ctx.from?.id;
				this.logger.log(`🔔 Callback query received from user ${userId}: ${data}`);
				
				// Answer callback query immediately to prevent timeout errors
				// If the query is too old, Telegram will return an error, but we'll handle it gracefully
				try {
					await ctx.answerCbQuery();
				} catch (error: unknown) {
					const errorMsg = (error as Error).message || '';
					if (errorMsg.includes('query is too old') || errorMsg.includes('timeout expired')) {
						this.logger.warn(`Callback query expired: ${data}`);
						return; // Silently ignore expired queries
					}
					throw error; // Re-throw other errors
				}

				const [action, vacancyId] = data.split(':');
				this.metricsService.telegramBotCallbacksTotal.inc({ action });

			// Обработка действий, которые не требуют vacancyId
			if (action === 'back_to_list') {
				await this.showList(ctx, undefined);
				return;
			}

			// Обработка навигации по страницам
			if (data.startsWith('list:page:')) {
				const parts = data.split(':');
				const page = parseInt(parts[2] || '1', 10);
				// Проверяем, является ли parts[3] сортировкой или статусом
				let status: string | undefined = undefined;
				let sortOrder: 'ASC' | 'DESC' = 'DESC';
				
				if (parts[3] === 'ASC' || parts[3] === 'DESC') {
					// parts[3] - это сортировка, статуса нет
					sortOrder = parts[3] as 'ASC' | 'DESC';
				} else if (parts[3]) {
					// parts[3] - это статус
					status = parts[3];
					// parts[4] может быть сортировкой
					if (parts[4] === 'ASC' || parts[4] === 'DESC') {
						sortOrder = parts[4] as 'ASC' | 'DESC';
					}
				} else {
					// parts[3] пустой, проверяем parts[4]
					if (parts[4] === 'ASC' || parts[4] === 'DESC') {
						sortOrder = parts[4] as 'ASC' | 'DESC';
					}
				}
				
				await this.showList(ctx, status, page, true, sortOrder);
				return;
			}

			if (data.startsWith('recent:page:')) {
				const parts = data.split(':');
				const page = parseInt(parts[2] || '1', 10);
				const limit = parseInt(parts[3] || '10', 10);
				const sortOrder = (parts[4] === 'ASC' || parts[4] === 'DESC') ? parts[4] as 'ASC' | 'DESC' : 'DESC';
				await this.showRecent(ctx, limit, page, true, sortOrder);
				return;
			}

			if (data.startsWith('search:page:')) {
				const parts = data.split(':');
				const page = parseInt(parts[2] || '1', 10);
				// Query может содержать ':', поэтому берем все части кроме последней (которая может быть sortOrder)
				const possibleSortOrder = parts[parts.length - 1];
				const sortOrder = (possibleSortOrder === 'ASC' || possibleSortOrder === 'DESC') ? possibleSortOrder as 'ASC' | 'DESC' : 'DESC';
				// Если последняя часть - это sortOrder, то query - это все части между page и sortOrder
				const queryParts = (possibleSortOrder === 'ASC' || possibleSortOrder === 'DESC') 
					? parts.slice(3, -1) 
					: parts.slice(3);
				const query = decodeURIComponent(queryParts.join(':') || '');
				if (query) {
					await this.showSearch(ctx, query, page, true, sortOrder);
				}
				return;
			}

			// Остальные действия требуют vacancyId
			if (!vacancyId) {
				await ctx.reply('❌ Ошибка: не указан ID вакансии', this.getMainMenu());
				return;
			}

			try {
				const vacancy = await this.vacancyRepository.findOne({ where: { id: vacancyId } });
				if (!vacancy) {
					await ctx.reply('❌ Вакансия не найдена', this.getMainMenu());
					return;
				}

                switch (action) {
					case 'view':
						// Показать детали вакансии
						await this.sendVacancyCard(ctx, vacancy, true);
						break;

					case 'mark_sent':
						vacancy.status = 'sent';
						vacancy.dmSent = true;
						await this.vacancyRepository.save(vacancy);
						const vacancyIdShort = vacancy?.id ? vacancy.id.substring(0, 8) : 'unknown';
						if (ctx.callbackQuery && 'message' in ctx.callbackQuery) {
							try {
								const newText = await this.formatVacancyText(vacancy, true);
								const newButtons = this.getVacancyButtons(vacancy);
								await ctx.editMessageText(newText, {
									reply_markup: newButtons.reply_markup,
								});
							} catch (error: unknown) {
								// Ignore "message is not modified" error
								if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
									// Message is already up to date, just acknowledge
									await ctx.answerCbQuery('✅ Уже обновлено');
								} else {
									throw error;
								}
							}
						} else {
							await ctx.reply(`✅ Вакансия #${vacancyIdShort} помечена как отправленная`, this.getMainMenu());
							await this.sendVacancyCard(ctx, vacancy, true);
						}
						break;

					case 'mark_processed':
						vacancy.status = 'processed';
						vacancy.dmSent = false;
						await this.vacancyRepository.save(vacancy);
						const vacancyIdShort2 = vacancy?.id ? vacancy.id.substring(0, 8) : 'unknown';
						if (ctx.callbackQuery && 'message' in ctx.callbackQuery) {
							try {
								const newText = await this.formatVacancyText(vacancy, true);
								const newButtons = this.getVacancyButtons(vacancy);
								await ctx.editMessageText(newText, {
									reply_markup: newButtons.reply_markup,
								});
							} catch (error: unknown) {
								// Ignore "message is not modified" error
								if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
									// Message is already up to date, just acknowledge
									await ctx.answerCbQuery('✅ Уже обновлено');
								} else {
									throw error;
								}
							}
						} else {
							await ctx.reply(`⏳ Вакансия #${vacancyIdShort2} помечена как обработанная`, this.getMainMenu());
							await this.sendVacancyCard(ctx, vacancy, true);
						}
						break;

					case 'delete':
						// Save ID before deletion
						const deletedId = vacancy.id;
						await this.vacancyRepository.remove(vacancy);
						const deletedIdShort = deletedId ? deletedId.substring(0, 8) : 'unknown';
						if (ctx.callbackQuery && 'message' in ctx.callbackQuery) {
							await ctx.editMessageText(`🗑 Вакансия #${deletedIdShort} удалена`);
						} else {
							await ctx.reply(`🗑 Вакансия #${deletedIdShort} удалена`, this.getMainMenu());
						}
						break;

					case 'refresh':
						const refreshed = await this.vacancyRepository.findOne({ where: { id: vacancy.id } });
						if (refreshed) {
							if (ctx.callbackQuery && 'message' in ctx.callbackQuery) {
								try {
									const newText = await this.formatVacancyText(refreshed, true);
									const newButtons = this.getVacancyButtons(refreshed);
									await ctx.editMessageText(newText, {
										reply_markup: newButtons.reply_markup,
									});
								} catch (error: unknown) {
									// Ignore "message is not modified" error
									if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
										// Message is already up to date, just acknowledge
										await ctx.answerCbQuery('✅ Уже обновлено');
									} else {
										throw error;
									}
								}
							} else {
								await this.sendVacancyCard(ctx, refreshed, true);
							}
						} else {
							await ctx.reply('❌ Вакансия не найдена', this.getMainMenu());
						}
						break;

                    case 'send_cv': {
                        const contact = (vacancy.contact || '').trim();
                        if (!contact || !/^@\w+$/i.test(contact)) {
                            await ctx.reply('❌ У вакансии нет Telegram-контакта для отправки CV', this.getMainMenu());
                            break;
                        }
                        const res = await this.userbotService.sendCvToContact(contact, '');
                        if (res.ok) {
                            await ctx.reply('📎 CV отправлен (или DRY_RUN).', this.getMainMenu());
                        } else {
                            await ctx.reply(`❌ Не удалось отправить CV: ${res.reason || 'unknown'}`, this.getMainMenu());
                        }
                        break;
                    }

					default:
						await ctx.reply('❌ Неизвестное действие', this.getMainMenu());
				}
			} catch (error: unknown) {
				this.logger.error(`Callback query error: ${(error as Error).message}`);
				this.logger.error(`Error stack: ${(error as Error).stack}`);
				await ctx.answerCbQuery('❌ Произошла ошибка');
				await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
			}
			} catch (error: unknown) {
				this.logger.error(`Callback query outer error: ${(error as Error).message}`);
				this.logger.error(`Error stack: ${(error as Error).stack}`);
				await ctx.answerCbQuery('❌ Произошла ошибка');
			}
		});
	}

	private formatVacancyLink(vacancy: Vacancy): string | null {
		if (vacancy.channelUsername) {
			// Remove @ prefix if present (shouldn't be, but just in case)
			const username = vacancy.channelUsername.startsWith('@') 
				? vacancy.channelUsername.substring(1) 
				: vacancy.channelUsername;
			return `https://t.me/${username}/${vacancy.messageId}`;
		}
		// Fallback: try to use numeric ID (may not work for private channels)
		if (vacancy.channelId) {
			// For public channels, numeric ID might work, but username is preferred
			return null;
		}
		return null;
	}

	private async formatVacancyText(vacancy: Vacancy, full: boolean = false): Promise<string> {
		if (!vacancy || !vacancy.id) {
			throw new Error('Invalid vacancy: missing id');
		}

		// Используем createdAt (дата публикации) вместо processedAt
		const publishedDate = vacancy.createdAt
			? new Date(vacancy.createdAt).toLocaleDateString('ru-RU', {
				day: '2-digit',
				month: '2-digit',
				year: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			})
			: 'N/A';

		const statusEmoji = vacancy.dmSent ? '✅' : vacancy.status === 'sent' ? '📤' : '⏳';
		const statusText = vacancy.dmSent ? 'Отправлено' : vacancy.status === 'sent' ? 'Отправлено' : 'Обработано';

		const vacancyIdShort = vacancy.id ? vacancy.id.substring(0, 8) : 'unknown';
		let text = `📋 Вакансия #${vacancyIdShort} ${statusEmoji}\n`;
		text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

		// Основная информация (только то, что есть в базе)
		if (vacancy.position) {
			text += `💼 ${vacancy.position}\n`;
		}
		if (vacancy.company) {
			text += `🏢 ${vacancy.company}\n`;
		}
		if (vacancy.salary) {
			text += `💰 ${vacancy.salary}\n`;
		}
		if (vacancy.location) {
			text += `📍 ${vacancy.location}\n`;
		}
		if (vacancy.workFormat) {
			text += `🏠 ${vacancy.workFormat}\n`;
		}
		if (vacancy.employment) {
			text += `⏰ ${vacancy.employment}\n`;
		}
		if (vacancy.contact) {
			text += `📞 ${vacancy.contact}\n`;
		}

		// Технологии (компактно)
		if (vacancy.stack && vacancy.stack.length > 0) {
			text += `\n🛠 ${vacancy.stack.join(', ')}\n`;
		}

		// Краткое саммари задач
		if (vacancy.summary) {
			text += `\n📝 ${vacancy.summary}\n`;
		}

		// LLM Reply - удаляем все https ссылки, чтобы не мешали превью
		if (vacancy.llmReply) {
			// Удаляем все https ссылки из llmReply
			let cleanReply = vacancy.llmReply.replace(/https?:\/\/[^\s]+/gi, '');
			text += `\n💬 Готовый ответ:\n${cleanReply}\n`;
		}

		// Метаданные (компактно)
		text += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
		text += `📅 ${publishedDate} | ${statusText}\n`;
		
		// Ссылка на оригинальное сообщение - должна быть единственной https ссылкой в тексте
		const link = this.formatVacancyLink(vacancy);
		if (link) {
			text += `\n${link}\n`;
		} else {
			text += `📺 ${vacancy.channelUsername || vacancy.channelId || 'N/A'} | #${vacancy.messageId}\n`;
		}
		
		return text;
	}

	private getVacancyButtons(vacancy: Vacancy, showBack: boolean = true) {
		if (!vacancy || !vacancy.id) {
			throw new Error('Invalid vacancy: missing id');
		}

		const buttons: any[] = [];
		
		// Компактные кнопки действий - в один ряд для мобильных
		const actionRow: any[] = [];
		
		// НЕ добавляем кнопку с ссылкой - ссылка уже в тексте для автоматического превью
		
		// Quick DM button (prefilled message to recruiter)
		const quickUrl = this.buildQuickReplyUrl(vacancy);
		if (quickUrl) {
			actionRow.push(Markup.button.url('✉️', quickUrl));
		}

		// Send CV via userbot (document + caption)
		if ((vacancy.contact || '').startsWith('@')) {
			actionRow.push(Markup.button.callback('📎', `send_cv:${vacancy.id}`));
		}
		
		if (actionRow.length > 0) {
			buttons.push(actionRow);
		}
		
		// Status button - более компактный
		if (!vacancy.dmSent) {
			buttons.push([Markup.button.callback('✅ Отправить', `mark_sent:${vacancy.id}`)]);
		} else {
			buttons.push([Markup.button.callback('⏳ В обработку', `mark_processed:${vacancy.id}`)]);
		}
		
		// Action buttons - компактные, по 2-3 в ряд
		const actionButtons: any[] = [];
		
		if (showBack) {
			actionButtons.push(Markup.button.callback('◀️ Назад', 'back_to_list'));
		}
		
		actionButtons.push(
			Markup.button.callback('🔄', `refresh:${vacancy.id}`),
			Markup.button.callback('🗑', `delete:${vacancy.id}`),
		);
		
		if (actionButtons.length > 0) {
			buttons.push(actionButtons);
		}
		
		// Always return at least one button
		if (buttons.length === 0) {
			buttons.push([Markup.button.callback('🔄 Обновить', `refresh:${vacancy.id}`)]);
		}
		
		const keyboard = Markup.inlineKeyboard(buttons);
		const vacancyIdShort = vacancy.id ? vacancy.id.substring(0, 8) : 'unknown';
		this.logger.log(`Created ${buttons.length} button rows (${buttons.reduce((sum, row) => sum + row.length, 0)} total buttons) for vacancy ${vacancyIdShort}`);
		this.logger.log(`Keyboard structure: ${JSON.stringify(keyboard.reply_markup)}`);
		return keyboard;
	}

	// Build prefilled chat link to recruiter like https://t.me/username?text=...
	private buildQuickReplyUrl(vacancy: Vacancy): string | null {
		const contact = (vacancy.contact || '').trim();
		if (!contact || !/^@\w+$/i.test(contact)) return null;
		const username = contact.replace(/^@/, '');
		// Prefer saved LLM reply; fallback to a short template
		let text = (vacancy.llmReply || '').trim();
		if (!text) {
			const parts: string[] = [];
			const name = 'Добрый день!';
			const who = vacancy.position || 'вакансия';
			const comp = vacancy.company ? ` в компании ${vacancy.company}` : '';
			parts.push(`${name} Заинтересовала ${who}${comp}.`);
			parts.push('Можем обсудить подробнее?');
			text = parts.join(' ');
		}
		// URL-encode text
		const encoded = encodeURIComponent(text);
		return `https://t.me/${username}?text=${encoded}`;
	}

	private async sendVacancyCard(ctx: Context, vacancy: Vacancy, full: boolean = false): Promise<void> {
		const text = await this.formatVacancyText(vacancy, full);
		const inlineButtons = this.getVacancyButtons(vacancy);
		
		// Debug: log buttons structure
		const buttonsCount = inlineButtons?.reply_markup?.inline_keyboard?.length || 0;
		const vacancyIdShort = vacancy?.id ? vacancy.id.substring(0, 8) : 'unknown';
		this.logger.log(`Sending vacancy card: vacancyId=${vacancyIdShort}, buttonRows=${buttonsCount}`);
		
		// Telegram has a limit of 4096 characters per message
		// If message is too long, split it and send buttons with the last part
		if (text.length > 4096) {
			const parts: string[] = [];
			let remaining = text;
			while (remaining.length > 4096) {
				const part = remaining.substring(0, 4096);
				const lastNewline = part.lastIndexOf('\n');
				if (lastNewline > 0) {
					parts.push(remaining.substring(0, lastNewline));
					remaining = remaining.substring(lastNewline + 1);
				} else {
					parts.push(part);
					remaining = remaining.substring(4096);
				}
			}
			// Send all parts except the last one
			for (let i = 0; i < parts.length; i++) {
				await ctx.reply(parts[i]);
			}
			// Send last part with inline buttons
			await ctx.reply(remaining, inlineButtons);
		} else {
			// Send with inline buttons - use same format as showList/showRecent
			try {
				this.logger.log(`About to send message with inlineButtons: ${JSON.stringify(inlineButtons)}`);
				await ctx.reply(text, inlineButtons);
				this.logger.log(`Message sent successfully with buttons`);
			} catch (error: unknown) {
				this.logger.error(`Failed to send vacancy card with buttons: ${(error as Error).message}`);
				this.logger.error(`Error stack: ${(error as Error).stack}`);
				// Fallback: try without buttons
				await ctx.reply(text);
			}
		}
	}

	// Вспомогательные методы для показа различных экранов
	private async showHelp(ctx: Context): Promise<void> {
		await ctx.reply(
			'📋 Помощь по использованию бота:\n\n' +
			'🔹 Используйте кнопки меню для быстрой навигации\n\n' +
			'📋 Список вакансий - показать все вакансии\n' +
			'📊 Статистика - общая статистика\n' +
			'🔍 Поиск - найти вакансии по ключевым словам\n' +
			'🕐 Последние - показать последние 10 вакансий\n\n' +
			'💡 Советы:\n' +
			'• Кликайте на кнопки в списке для просмотра деталей\n' +
			'• Используйте кнопку "◀️ Назад" для возврата к списку\n' +
			'• Ссылка на оригинальное сообщение отображается автоматически в карточке',
			this.getMainMenu(),
		);
	}

	private async showStats(ctx: Context): Promise<void> {
		try {
			const [total, processed, sent, withDm] = await Promise.all([
				this.vacancyRepository.count(),
				this.vacancyRepository.count({ where: { status: 'processed' } }),
				this.vacancyRepository.count({ where: { status: 'sent' } }),
				this.vacancyRepository.count({ where: { dmSent: true } }),
			]);

			const statsText =
				'📊 Статистика вакансий:\n\n' +
				`📋 Всего: ${total}\n` +
				`⏳ Обработано: ${processed}\n` +
				`📤 Отправлено: ${sent}\n` +
				`✅ С DM: ${withDm}`;

			await ctx.reply(statsText, this.getMainMenu());
		} catch (error: unknown) {
			await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
		}
	}

	private async showList(ctx: Context, status?: string, page: number = 1, edit: boolean = false, sortOrder: 'ASC' | 'DESC' = 'DESC'): Promise<void> {
		try {
			const where: any = {};
			if (status) {
				where.status = status;
			}

			const pageSize = 10;
			const skip = (page - 1) * pageSize;

			const total = await this.vacancyRepository.count({ where });
			const totalPages = Math.ceil(total / pageSize);

			if (total === 0) {
				await ctx.reply(status ? `📭 Нет вакансий со статусом "${status}"` : '📭 Нет вакансий', this.getMainMenu());
				return;
			}

			if (page < 1) page = 1;
			if (page > totalPages) page = totalPages;

			const vacancies = await this.vacancyRepository.find({
				where,
				order: { createdAt: sortOrder },
				skip,
				take: pageSize,
			});
		
			// Формируем компактный список для мобильных устройств
			const listItems: string[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const position = v.position || 'N/A';
				const company = v.company ? ` • ${v.company}` : '';
				const salary = v.salary ? ` • ${v.salary}` : '';
				// Используем createdAt (дата публикации) вместо processedAt
				const date = v.createdAt 
					? new Date(v.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
					: '';
				const dateStr = date ? ` • ${date}` : '';
				const globalIndex = skip + index + 1;
				listItems.push(`${statusEmoji} ${globalIndex}. ${position}${company}${salary}${dateStr}`);
			});
			
			const text = `📋 Вакансии (${skip + 1}-${skip + vacancies.length} из ${total}, стр. ${page}/${totalPages}):\n\n${listItems.join('\n')}\n\n👇 Выберите вакансию:`;

			// Создаем кнопки: номер, статус и компания, по 2 в ряд
			const buttons: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
			let currentRow: ReturnType<typeof Markup.button.callback>[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const globalIndex = skip + index + 1;
				const company = (v.company || 'N/A').substring(0, 15);
				const label = `${statusEmoji} ${globalIndex}. ${company}`;
				currentRow.push(Markup.button.callback(label.substring(0, 64), `view:${v.id}`));
				if (currentRow.length === 2) {
					buttons.push(currentRow);
					currentRow = [];
				}
			});
			if (currentRow.length > 0) {
				buttons.push(currentRow);
			}

			// Кнопки навигации и сортировки
			const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
			if (page > 1) {
				// Формируем callback data: list:page:1 или list:page:1:status или list:page:1:ASC или list:page:1:status:ASC
				const statusPart = status ? `:${status}` : '';
				const sortPart = `:${sortOrder}`;
				navButtons.push(Markup.button.callback('◀️ Предыдущая', `list:page:${page - 1}${statusPart}${sortPart}`));
			}
			if (page < totalPages) {
				const statusPart = status ? `:${status}` : '';
				const sortPart = `:${sortOrder}`;
				navButtons.push(Markup.button.callback('Следующая ▶️', `list:page:${page + 1}${statusPart}${sortPart}`));
			}
			if (navButtons.length > 0) {
				buttons.push(navButtons);
			}
			
			// Кнопка переключения сортировки
			const sortLabel = sortOrder === 'DESC' ? '📅 Новые → Старые' : '📅 Старые → Новые';
			const newSortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
			const statusPart = status ? `:${status}` : '';
			const sortPart = `:${newSortOrder}`;
			buttons.push([Markup.button.callback(sortLabel, `list:page:${page}${statusPart}${sortPart}`)]);

			const keyboard = Markup.inlineKeyboard(buttons);
			if (edit && ctx.callbackQuery && 'message' in ctx.callbackQuery) {
				try {
					await ctx.editMessageText(text, { ...keyboard });
				} catch (error: unknown) {
					if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
						await ctx.answerCbQuery('✅ Уже обновлено');
					} else {
						await ctx.reply(text, { ...keyboard });
					}
				}
			} else {
				await ctx.reply(text, { ...keyboard });
			}
		} catch (error: unknown) {
			await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
		}
	}

	private async showRecent(ctx: Context, limit: number, page: number = 1, edit: boolean = false, sortOrder: 'ASC' | 'DESC' = 'DESC'): Promise<void> {
		try {
			const pageSize = 10;
			const skip = (page - 1) * pageSize;

			const total = await this.vacancyRepository.count();
			const maxItems = Math.min(limit, total);
			const totalPages = Math.ceil(maxItems / pageSize);

			if (total === 0) {
				await ctx.reply('📭 Нет вакансий', this.getMainMenu());
				return;
			}

			if (page < 1) page = 1;
			if (page > totalPages) page = totalPages;

			const vacancies = await this.vacancyRepository.find({
				order: { createdAt: sortOrder },
				skip,
				take: pageSize,
			});

			if (vacancies.length === 0) {
				await ctx.reply('📭 Нет вакансий', this.getMainMenu());
				return;
			}

			// Формируем компактный список для мобильных устройств
			const listItems: string[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const position = v.position || 'N/A';
				const company = v.company ? ` • ${v.company}` : '';
				const salary = v.salary ? ` • ${v.salary}` : '';
				// Используем createdAt (дата публикации) вместо processedAt
				const date = v.createdAt 
					? new Date(v.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
					: '';
				const dateStr = date ? ` • ${date}` : '';
				const globalIndex = skip + index + 1;
				listItems.push(`${statusEmoji} ${globalIndex}. ${position}${company}${salary}${dateStr}`);
			});
			
			const text = `🕐 Последние вакансии (${skip + 1}-${Math.min(skip + vacancies.length, maxItems)} из ${maxItems}, стр. ${page}/${totalPages}):\n\n${listItems.join('\n')}\n\n👇 Выберите вакансию:`;

			// Создаем кнопки: номер, статус и компания, по 2 в ряд
			const buttons: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
			let currentRow: ReturnType<typeof Markup.button.callback>[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const globalIndex = skip + index + 1;
				const company = (v.company || 'N/A').substring(0, 15);
				const label = `${statusEmoji} ${globalIndex}. ${company}`;
				currentRow.push(Markup.button.callback(label.substring(0, 64), `view:${v.id}`));
				if (currentRow.length === 2) {
					buttons.push(currentRow);
					currentRow = [];
				}
			});
			if (currentRow.length > 0) {
				buttons.push(currentRow);
			}

			// Кнопки навигации и сортировки
			const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
			if (page > 1) {
				navButtons.push(Markup.button.callback('◀️ Предыдущая', `recent:page:${page - 1}:${limit}:${sortOrder}`));
			}
			if (page < totalPages) {
				navButtons.push(Markup.button.callback('Следующая ▶️', `recent:page:${page + 1}:${limit}:${sortOrder}`));
			}
			if (navButtons.length > 0) {
				buttons.push(navButtons);
			}
			
			// Кнопка переключения сортировки
			const sortLabel = sortOrder === 'DESC' ? '📅 Новые → Старые' : '📅 Старые → Новые';
			const newSortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
			buttons.push([Markup.button.callback(sortLabel, `recent:page:${page}:${limit}:${newSortOrder}`)]);

			const keyboard = Markup.inlineKeyboard(buttons);
			if (edit && ctx.callbackQuery && 'message' in ctx.callbackQuery) {
				try {
					await ctx.editMessageText(text, { ...keyboard });
				} catch (error: unknown) {
					if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
						await ctx.answerCbQuery('✅ Уже обновлено');
					} else {
						await ctx.reply(text, { ...keyboard });
					}
				}
			} else {
				await ctx.reply(text, { ...keyboard });
			}
		} catch (error: unknown) {
			await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
		}
	}

	private async showSearch(ctx: Context, query: string, page: number = 1, edit: boolean = false, sortOrder: 'ASC' | 'DESC' = 'DESC'): Promise<void> {
		try {
			const pageSize = 10;
			const skip = (page - 1) * pageSize;

			const where = [
				{ fullText: Like(`%${query}%`) },
				{ position: Like(`%${query}%`) },
				{ company: Like(`%${query}%`) },
			];

			const total = await this.vacancyRepository.count({ where });
			const totalPages = Math.ceil(total / pageSize);

			if (total === 0) {
				await ctx.reply(`🔍 По запросу "${query}" ничего не найдено`, this.getMainMenu());
				return;
			}

			if (page < 1) page = 1;
			if (page > totalPages) page = totalPages;

			const vacancies = await this.vacancyRepository.find({
				where,
				order: { createdAt: sortOrder },
				skip,
				take: pageSize,
			});

			// Формируем компактный список для мобильных устройств
			const listItems: string[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const position = v.position || 'N/A';
				const company = v.company ? ` • ${v.company}` : '';
				const salary = v.salary ? ` • ${v.salary}` : '';
				// Используем createdAt (дата публикации) вместо processedAt
				const date = v.createdAt 
					? new Date(v.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
					: '';
				const dateStr = date ? ` • ${date}` : '';
				const globalIndex = skip + index + 1;
				listItems.push(`${statusEmoji} ${globalIndex}. ${position}${company}${salary}${dateStr}`);
			});
			
			const text = `🔍 Найдено ${vacancies.length} вакансий по запросу "${query}" (${skip + 1}-${skip + vacancies.length} из ${total}, стр. ${page}/${totalPages}):\n\n${listItems.join('\n')}\n\n👇 Выберите вакансию:`;

			// Создаем кнопки: номер, статус и компания, по 2 в ряд
			const buttons: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
			let currentRow: ReturnType<typeof Markup.button.callback>[] = [];
			vacancies.forEach((v, index) => {
				const statusEmoji = v.dmSent ? '✅' : v.status === 'sent' ? '📤' : '⏳';
				const globalIndex = skip + index + 1;
				const company = (v.company || 'N/A').substring(0, 15);
				const label = `${statusEmoji} ${globalIndex}. ${company}`;
				currentRow.push(Markup.button.callback(label.substring(0, 64), `view:${v.id}`));
				if (currentRow.length === 2) {
					buttons.push(currentRow);
					currentRow = [];
				}
			});
			if (currentRow.length > 0) {
				buttons.push(currentRow);
			}

			// Кнопки навигации и сортировки
			const navButtons: ReturnType<typeof Markup.button.callback>[] = [];
			if (page > 1) {
				navButtons.push(Markup.button.callback('◀️ Предыдущая', `search:page:${page - 1}:${encodeURIComponent(query)}:${sortOrder}`));
			}
			if (page < totalPages) {
				navButtons.push(Markup.button.callback('Следующая ▶️', `search:page:${page + 1}:${encodeURIComponent(query)}:${sortOrder}`));
			}
			if (navButtons.length > 0) {
				buttons.push(navButtons);
			}
			
			// Кнопка переключения сортировки
			const sortLabel = sortOrder === 'DESC' ? '📅 Новые → Старые' : '📅 Старые → Новые';
			const newSortOrder = sortOrder === 'DESC' ? 'ASC' : 'DESC';
			buttons.push([Markup.button.callback(sortLabel, `search:page:${page}:${encodeURIComponent(query)}:${newSortOrder}`)]);

			const keyboard = Markup.inlineKeyboard(buttons);
			if (edit && ctx.callbackQuery && 'message' in ctx.callbackQuery) {
				try {
					await ctx.editMessageText(text, { ...keyboard });
				} catch (error: unknown) {
					if ((error as Error).message && (error as Error).message.includes('message is not modified')) {
						await ctx.answerCbQuery('✅ Уже обновлено');
					} else {
						await ctx.reply(text, { ...keyboard });
					}
				}
			} else {
				await ctx.reply(text, { ...keyboard });
			}
		} catch (error: unknown) {
			await ctx.reply(`❌ Ошибка: ${(error as Error).message}`, this.getMainMenu());
		}
	}
}

