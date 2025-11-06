import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { NewMessage } from 'telegram/events';
import { RedisService } from '../redis/redis.service';
import { Vacancy } from '../database/vacancy.entity';

type ChannelPost = {
	peerId: number;
	messageId: number;
	text: string;
};

@Injectable()
export class UserbotService implements OnModuleInit, OnModuleDestroy {
	private readonly logger = new Logger(UserbotService.name);
	private client?: TelegramClient;
	private started = false;
	private readonly channelIdentifiers: string[];
	private readonly keywords: string[];
	private readonly replyTemplate: string;
	private readonly dmMaxPerPost: number;
	private readonly dmDelayMs: number;
	private readonly dryRun: boolean;
	private readonly backfillOnStart: boolean;
	private readonly backfillLimit: number;
	private readonly backfillSinceDays?: number;
	private readonly logAllMessages: boolean;
	private readonly logFull: boolean;
	private readonly debugLogs: boolean;
	private readonly channelUsernameToIdCache: Map<string, string> = new Map(); // username -> numeric ID cache
	private readonly autoReplyEnabled: boolean = true;
	// LLM config
	private readonly llmEnabled: boolean = false;
	private llmEndpoint?: string;
	private llmModel?: string;
	private readonly llmExtractFields: boolean = false;
	private llmApiType: 'ollama' | 'openai' = 'ollama'; // API type: ollama or openai
	private readonly llmApiKey?: string; // API key for OpenAI

	// Separate configs for extract vs reply (fallback to generic if not set)
	private extractApiType?: 'ollama' | 'openai';
	private extractEndpoint?: string;
	private extractModel?: string;
	private replyApiType?: 'ollama' | 'openai';
	private replyEndpoint?: string;
	private replyModel?: string;
	private readonly replyTemperature: number = 0.7;
	private readonly replyMaxTokens: number = 90;
	private readonly replyMaxChars: number = 180;
	private readonly candidateProfile?: string;
	private cvFilePath?: string;
	private readonly cvCaptionTemplate?: string;
	private stats = {
		totalProcessed: 0,
		skippedNoKeyword: 0,
		skippedDuplicate: 0,
		skippedNotAllowed: 0,
		successfullyProcessed: 0,
	};

	constructor(
		private readonly configService: ConfigService,
		private readonly redisService: RedisService,
		@InjectRepository(Vacancy)
		private readonly vacancyRepository: Repository<Vacancy>,
	) {
		this.channelIdentifiers = this.parseListFromConfig('TELEGRAM_CHANNEL_IDS').map((v) => v.toLowerCase());
		this.keywords = this.parseListFromConfig('TELEGRAM_JOB_KEYWORDS').map((k) => k.toLowerCase());
		this.replyTemplate = this.configService.get<string>('TELEGRAM_REPLY_TEMPLATE') ?? '';
		this.dmMaxPerPost = Number(this.configService.get<string>('TELEGRAM_DM_MAX', '3')) || 3;
		this.dmDelayMs = Number(this.configService.get<string>('TELEGRAM_DM_DELAY_MS', '1500')) || 1500;
		const dry = (this.configService.get<string>('TELEGRAM_DRY_RUN') || '').toLowerCase();
		this.dryRun = dry === '1' || dry === 'true' || dry === 'yes';
		const backfill = (this.configService.get<string>('TELEGRAM_BACKFILL_ON_START') || '').toLowerCase();
		this.backfillOnStart = backfill === '1' || backfill === 'true' || backfill === 'yes';
		this.backfillLimit = Number(this.configService.get<string>('TELEGRAM_BACKFILL_LIMIT', '50')) || 50;
		const sinceDaysRaw = this.configService.get<string>('TELEGRAM_BACKFILL_SINCE_DAYS');
		this.backfillSinceDays = sinceDaysRaw ? Number(sinceDaysRaw) : undefined;
		const logFlag = (this.configService.get<string>('TELEGRAM_LOG_MESSAGES') || '').toLowerCase();
		this.logAllMessages = logFlag === '1' || logFlag === 'true' || logFlag === 'yes';
		const logFullFlag = (this.configService.get<string>('TELEGRAM_LOG_FULL') || '').toLowerCase();
		this.logFull = logFullFlag === '1' || logFullFlag === 'true' || logFullFlag === 'yes';
		const debugFlag = (this.configService.get<string>('TELEGRAM_DEBUG') || '').toLowerCase();
		this.debugLogs = debugFlag === '1' || debugFlag === 'true' || debugFlag === 'yes';
		const autoReplyFlag = (this.configService.get<string>('TELEGRAM_AUTO_REPLY') || 'true').toLowerCase();
		(this as any).autoReplyEnabled = autoReplyFlag === '1' || autoReplyFlag === 'true' || autoReplyFlag === 'yes';
		// Candidate profile (optional, used to personalize replies)
		this.candidateProfile = this.configService.get<string>('CANDIDATE_PROFILE') || undefined;
		this.cvFilePath = this.configService.get<string>('CV_FILE_PATH') || undefined;
		this.cvCaptionTemplate = this.configService.get<string>('CV_CAPTION') || undefined;

		// LLM settings
		const llmFlag = (this.configService.get<string>('LLM_ENABLED') || '').toLowerCase();
		this.llmEnabled = llmFlag === '1' || llmFlag === 'true' || llmFlag === 'yes';
		this.llmEndpoint = this.configService.get<string>('LLM_ENDPOINT') || undefined;
		this.llmModel = this.configService.get<string>('LLM_MODEL') || undefined;
		const llmExtractFlag = (this.configService.get<string>('LLM_EXTRACT_FIELDS') || '').toLowerCase();
		this.llmExtractFields = llmExtractFlag === '1' || llmExtractFlag === 'true' || llmExtractFlag === 'yes';
		// Determine API type: 'openai' for OpenAI API, 'ollama' for Ollama
		const apiType = (this.configService.get<string>('LLM_API_TYPE') || 'ollama').toLowerCase();
		this.llmApiType = (apiType === 'openai' || apiType === 'gpt' || apiType === 'chatgpt') ? 'openai' : 'ollama';
		// Per-role overrides
		const extractApi = (this.configService.get<string>('LLM_EXTRACT_API_TYPE') || '').toLowerCase();
		this.extractApiType = extractApi ? ((extractApi === 'openai' || extractApi === 'gpt' || extractApi === 'chatgpt') ? 'openai' : 'ollama') : undefined;
		this.extractEndpoint = this.configService.get<string>('LLM_EXTRACT_ENDPOINT') || undefined;
		this.extractModel = this.configService.get<string>('LLM_EXTRACT_MODEL') || undefined;
		const replyApi = (this.configService.get<string>('LLM_REPLY_API_TYPE') || '').toLowerCase();
		this.replyApiType = replyApi ? ((replyApi === 'openai' || replyApi === 'gpt' || replyApi === 'chatgpt') ? 'openai' : 'ollama') : undefined;
		this.replyEndpoint = this.configService.get<string>('LLM_REPLY_ENDPOINT') || undefined;
		this.replyModel = this.configService.get<string>('LLM_REPLY_MODEL') || undefined;
		// Reply generation tuning
		const temp = Number(this.configService.get<string>('LLM_REPLY_TEMPERATURE', '0.7'));
		if (Number.isFinite(temp)) (this as any).replyTemperature = temp;
		const mxTok = Number(this.configService.get<string>('LLM_REPLY_MAX_TOKENS', '90'));
		if (Number.isFinite(mxTok)) (this as any).replyMaxTokens = mxTok;
		const mxChars = Number(this.configService.get<string>('LLM_REPLY_MAX_CHARS', '180'));
		if (Number.isFinite(mxChars)) (this as any).replyMaxChars = mxChars;
		// OpenAI API key (required if using OpenAI API)
		this.llmApiKey = this.configService.get<string>('OPENAI_API_KEY') || undefined;
		// If OpenAI API type is selected, use OpenAI endpoint by default
		if (this.llmApiType === 'openai' && !this.llmEndpoint) {
			this.llmEndpoint = 'https://api.openai.com';
		}
		if ((this.extractApiType ?? this.llmApiType) === 'openai' && !this.extractEndpoint) {
			this.extractEndpoint = this.llmApiType === 'openai' ? (this.llmEndpoint || 'https://api.openai.com') : 'https://api.openai.com';
		}
		if ((this.replyApiType ?? this.llmApiType) === 'openai' && !this.replyEndpoint) {
			this.replyEndpoint = this.llmApiType === 'openai' ? (this.llmEndpoint || 'https://api.openai.com') : 'https://api.openai.com';
		}
	}

	async onModuleInit(): Promise<void> {
		const apiIdStr = this.configService.get<string>('TELEGRAM_API_ID');
		const apiHash = this.configService.get<string>('TELEGRAM_API_HASH');
		const sessionStr = this.configService.get<string>('TELEGRAM_SESSION');

		if (!apiIdStr || !apiHash || !sessionStr) {
			this.logger.log('Userbot not configured (TELEGRAM_API_ID/API_HASH/SESSION missing); skipping');
			return;
		}

		const apiId = Number(apiIdStr);
		if (!Number.isFinite(apiId)) {
			this.logger.error('TELEGRAM_API_ID must be a number');
			return;
		}

		try {
			this.client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
				deviceModel: 'devops-demo-userbot',
				appVersion: '1.0',
				systemVersion: 'Node',
			});

			await this.client.connect();
			this.started = true;
			this.logger.log('Userbot connected');
			this.logger.log(
				`Userbot config: dryRun=${this.dryRun}, logAll=${this.logAllMessages}, logFull=${this.logFull}, backfillOnStart=${this.backfillOnStart}, backfillLimit=${this.backfillLimit}, sinceDays=${this.backfillSinceDays ?? 'n/a'}, channels=${this.channelIdentifiers.join(',') || 'ALL'}, keywords=[${this.keywords.length > 0 ? this.keywords.join(',') : 'NONE (all messages will pass)'}]`,
			);
			this.logger.log(
				`LLM config: enabled=${this.llmEnabled} extractFields=${this.llmExtractFields} apiType=${this.llmApiType} endpoint=${this.llmEndpoint ?? 'n/a'} model=${this.llmModel ?? 'n/a'}`,
			);
		} catch (error: unknown) {
			this.logger.error(`Failed to connect userbot: ${(error as Error).message}`);
			return;
		}

		// Subscribe to new messages via event builder (more reliable for live updates)
		this.client.addEventHandler(async (event) => {
			try {
				const newMessage = (event as any).message as Api.Message | undefined;
				if (!newMessage || !(newMessage instanceof Api.Message)) {
					return;
				}

				if (!newMessage.peerId) {
					return;
				}

				const isChannel = newMessage.peerId instanceof Api.PeerChannel;
				if (!isChannel) {
					return;
				}


				await this.processApiMessage(newMessage);
			} catch (err: unknown) {
				this.logger.error(`Userbot handler error: ${(err as Error).message}`);
			}
		}, new NewMessage({}));

		if (this.backfillOnStart) {
			void this.runBackfill();
		}
	}

	onModuleDestroy(): void {
		void this.stop('NestJS shutdown');
	}

	private async stop(reason: string): Promise<void> {
		if (!this.client || !this.started) return;
		try {
			await this.client.disconnect();
			this.started = false;
			this.logger.log(`Userbot disconnected (${reason})`);
		} catch (e: unknown) {
			this.logger.error(`Userbot disconnect error: ${(e as Error).message}`);
		}
	}

	private async processApiMessage(newMessage: Api.Message): Promise<void> {
		const channelIdBig = (newMessage.peerId as Api.PeerChannel).channelId as any;
		const peerId = typeof channelIdBig?.toString === 'function' ? channelIdBig.toString() : String(channelIdBig ?? '');
		const messageId = newMessage.id;
		const text = this.extractMessageText(newMessage);
		// Extract message publication date from Telegram
		let ts: Date;
		if (newMessage.date) {
			// Telegram date is usually a number (Unix timestamp) or Date object
			if (typeof newMessage.date === 'number') {
				ts = new Date(newMessage.date * 1000); // Convert Unix timestamp to Date
			} else if ((newMessage.date as any)?.getTime) {
				ts = new Date((newMessage.date as any).getTime());
			} else {
				ts = new Date();
				if (this.debugLogs) {
					this.logger.warn(`Could not parse message date, using current date. date type: ${typeof newMessage.date}, value: ${newMessage.date}`);
				}
			}
		} else {
			ts = new Date();
			if (this.debugLogs) {
				this.logger.warn(`Message date is missing, using current date for messageId ${messageId}`);
			}
		}
		if (this.debugLogs) {
			this.logger.log(`Message date extracted: ${ts.toISOString()} for messageId ${messageId}`);
		}

		// Get channel username for link generation
		let channelUsername: string | undefined;
		if (this.client) {
			try {
				// Try to get entity directly from peerId
				const entity = await this.client.getEntity(newMessage.peerId as any);
				const rawUsername = (entity as any).username;
				if (rawUsername) {
					// Remove @ prefix if present, we'll add it when constructing the link
					channelUsername = rawUsername.startsWith('@') ? rawUsername.substring(1) : rawUsername;
					if (this.debugLogs) {
						this.logger.log(`Resolved channel username: ${channelUsername} for peerId ${peerId}`);
					}
				} else {
					// Fallback: try to get from cache if we have a username identifier
					const usernameId = this.channelIdentifiers.find(id => id.startsWith('@'));
					if (usernameId) {
						const cachedId = this.channelUsernameToIdCache.get(usernameId.toLowerCase());
						if (cachedId === peerId) {
							// Extract username from identifier (remove @)
							channelUsername = usernameId.substring(1);
							if (this.debugLogs) {
								this.logger.log(`Using cached channel username: ${channelUsername} for peerId ${peerId}`);
							}
						}
					}
					if (!channelUsername && this.debugLogs) {
						this.logger.log(`Channel username not available for peerId ${peerId}`);
					}
				}
			} catch (e) {
				// Failed to resolve username, try cache fallback
				const usernameId = this.channelIdentifiers.find(id => id.startsWith('@'));
				if (usernameId) {
					const cachedId = this.channelUsernameToIdCache.get(usernameId.toLowerCase());
					if (cachedId === peerId) {
						channelUsername = usernameId.substring(1);
						if (this.debugLogs) {
							this.logger.log(`Using cached channel username (fallback): ${channelUsername} for peerId ${peerId}`);
						}
					}
				}
				if (!channelUsername && this.debugLogs) {
					this.logger.log(`Could not resolve channel username: ${(e as Error).message}`);
				}
			}
		}

		if (this.debugLogs) {
			this.logger.log(`PROC start ch=${peerId} id=${messageId} textLen=${text?.length ?? 0}`);
		}

		if (!text) {
			if (this.debugLogs) {
				this.logger.log(`PROC skip(no-text) ch=${peerId} id=${messageId}`);
			}
			return;
		}

		if (!await this.isChannelAllowed(newMessage)) {
			this.stats.skippedNotAllowed++;
			if (this.debugLogs) {
				this.logger.log(`PROC skip(not-allowed) ch=${peerId} id=${messageId}`);
			}
			return;
		}

		// Log channel-passed messages for debugging
		if (this.logAllMessages || this.debugLogs) {
			const preview = text.substring(0, 100);
			this.logger.log(`MSG ch=${peerId} id=${messageId} len=${text.length} preview="${preview}${text.length > 100 ? '...' : ''}"`);
		}

		this.stats.totalProcessed++;
		
		// Log stats every 20 messages
		if (this.stats.totalProcessed % 20 === 0) {
			this.logStats();
		}
		
		if (this.keywords.length > 0 && !this.hasKeywordMatch(text)) {
			this.stats.skippedNoKeyword++;
			this.logger.log(`PROC skip(no-keyword) ch=${peerId} id=${messageId} keywords=[${this.keywords.join(',')}] textPreview="${text.substring(0, 150)}"`);
			return;
		}

		const processed = await this.markProcessedOnce(peerId, messageId);
		if (!processed) {
			this.stats.skippedDuplicate++;
			if (this.debugLogs) {
				this.logger.log(`PROC skip(duplicate) ch=${peerId} id=${messageId}`);
			}
			return;
		}

		const mentions = this.extractMentions(text);
		const links = this.extractLinks(text);
		const digest = { text, mentions, links };

		// Get publisher username from message
		const publisherUsername = await this.getPublisherUsername(newMessage);

		// Pretty, structured log for relevant messages (log line-by-line for aligned prefix)
		this.stats.successfullyProcessed++;
		this.renderPrettyRelevantLog({
			peerId,
			messageId,
			text,
			mentions,
			links,
			ts,
			publisherUsername,
		}).split('\n').forEach((line) => this.logger.log(line));

		// Parse fields: try LLM first if LLM is configured (primary method), fallback to regex
		// LLM is now the primary parsing method since messages have varying structures
		let fields: ReturnType<typeof this.parseMessageFields>;
		let stack: string[];
		let tasks: string[] = [];
		let contact: string | undefined;
		let position: string;
		let summary: string | undefined;

		if (this.llmEnabled && this.llmEndpoint && this.llmModel) {
			// LLM is configured - use it as primary method
			try {
				this.logger.log(`LLM extract (primary) for message ${messageId}`);
				const llmFields = await this.extractFieldsWithLlm(text);
				if (llmFields) {
					const extractedCount = Object.keys(llmFields).filter(k => llmFields[k as keyof typeof llmFields]).length;
					this.logger.log(`LLM extract success: extracted ${extractedCount} fields`);
					
					// Use LLM results as primary data source
					position = llmFields.position || 'DevOps';
					fields = {
						price: llmFields.salary,
						company: llmFields.company,
						location: llmFields.location,
						workFormat: llmFields.workFormat,
						employment: llmFields.employment,
						contact: llmFields.contact,
						hashtags: llmFields.hashtags ? llmFields.hashtags.map((h) => h.startsWith('#') ? h : `#${h}`) : [],
					};
					stack = llmFields.stack || [];
					tasks = llmFields.tasks || [];
					contact = llmFields.contact || this.deriveRecruiterContact(text, publisherUsername);
					summary = llmFields.summary;
					
					if (this.debugLogs) {
						if (stack.length > 0) {
							this.logger.log(`LLM extract stack: ${stack.join(', ')}`);
						}
						if (tasks.length > 0) {
							this.logger.log(`LLM extract tasks: ${tasks.length} tasks extracted`);
						}
					}
					
					// Fill in missing fields with regex fallback
					const regexFields = this.parseMessageFields(text);
					if (!fields.price && regexFields.price) fields.price = regexFields.price;
					if (!fields.company && regexFields.company) fields.company = regexFields.company;
					if (!fields.location && regexFields.location) fields.location = regexFields.location;
					if (!fields.workFormat && regexFields.workFormat) fields.workFormat = regexFields.workFormat;
					if (!fields.employment && regexFields.employment) fields.employment = regexFields.employment;
					if (!contact && regexFields.contact) contact = regexFields.contact;
					if (fields.hashtags.length === 0 && regexFields.hashtags.length > 0) {
						fields.hashtags = regexFields.hashtags;
					}
					if (stack.length === 0) {
						stack = this.extractStackFromText(text);
					}
				} else {
					// LLM returned null - use regex fallback
					this.logger.log(`LLM extract returned null, using regex fallback`);
					fields = this.parseMessageFields(text);
					stack = this.extractStackFromText(text);
					tasks = [];
					summary = undefined;
					contact = this.deriveRecruiterContact(text, publisherUsername);
					position = 'DevOps';
				}
			} catch (e: unknown) {
				// LLM failed - use regex fallback
				this.logger.warn(`LLM field extraction failed, using regex fallback: ${(e as Error).message}`);
				fields = this.parseMessageFields(text);
				stack = this.extractStackFromText(text);
				tasks = [];
				summary = undefined;
				contact = this.deriveRecruiterContact(text, publisherUsername);
				position = 'DevOps';
			}
		} else {
			// LLM not configured - use regex only
			fields = this.parseMessageFields(text);
			stack = this.extractStackFromText(text);
			tasks = [];
			summary = undefined;
			contact = this.deriveRecruiterContact(text, publisherUsername);
			position = 'DevOps';
		}

		// LLM generation (log-only) for a short personalized reply
		let llmReplyText: string | undefined;
		if (this.llmEnabled && this.llmEndpoint && this.llmModel) {
			try {
				const contactForPrompt = contact; // optional now
				const publisherRaw = this.extractPublisherDisplayName(text);
				const publisherDisplayName = this.normalizePublisherNameToRussian(publisherRaw);
				const prompt = this.buildShortReplyPrompt({
					contact: contactForPrompt,
					publisherName: publisherDisplayName,
					position,
					company: fields.company,
					format: fields.workFormat,
					location: fields.location,
					salary: fields.price,
					stack,
					rawText: text,
				});
				if (this.debugLogs) this.logger.log(`LLM try model=${this.llmModel} endpoint=${this.llmEndpoint}`);
				const llmText = await this.callLlmGenerate(prompt);
				if (this.debugLogs) this.logger.log(`LLM prompt: ${prompt.replace(/\s+/g,' ').trim()}`);
				let replyText = llmText;
				// Fallback: if model returned meta/empty, synthesize from template
				if (!replyText || replyText.trim().length < 10) {
					replyText = this.buildTemplateReply({ publisherName: publisherDisplayName, company: fields.company, position, stack });
				}
				if (replyText) {
					llmReplyText = replyText;
					this.logger.log(`LLM reply: ${replyText}`);
				}
			} catch (e: unknown) {
				this.logger.warn(`LLM generation failed: ${(e as Error).message}`);
			}
		} else if (this.debugLogs) {
			this.logger.log('LLM skipped: disabled or missing LLM_ENDPOINT/LLM_MODEL');
		}

		if (this.debugLogs) {
			this.logger.log(`PROC digest ch=${peerId} id=${messageId} mentions=${mentions.length} links=${links.length}`);
		}

		// Save vacancy to database
		try {
			// Use message date (ts) for createdAt to reflect actual publication date
			const vacancy = this.vacancyRepository.create({
				channelId: peerId,
				channelUsername,
				messageId,
				fullText: text,
				position,
				company: fields.company,
				salary: fields.price,
				location: fields.location,
				workFormat: fields.workFormat,
				employment: fields.employment,
				contact: contact || fields.contact,
				hashtags: fields.hashtags,
				stack,
				tasks,
				summary,
				llmReply: llmReplyText,
				status: 'processed',
				dmSent: false,
				processedAt: new Date(),
				createdAt: ts, // Use message publication date instead of current date
			});
			await this.vacancyRepository.save(vacancy);
			if (this.debugLogs) {
				this.logger.log(`Vacancy saved: id=${vacancy.id} channelId=${peerId} channelUsername=${channelUsername || 'N/A'} messageId=${messageId} createdAt=${vacancy.createdAt?.toISOString() || 'N/A'}`);
			}
		} catch (e: unknown) {
			this.logger.warn(`Failed to save vacancy: ${(e as Error).message}`);
		}

		if (this.autoReplyEnabled) {
			await this.sendDmReplies(digest, peerId, messageId, llmReplyText, { contact, position, company: fields.company, format: fields.workFormat, location: fields.location, salary: fields.price, stack });
		} else if (this.debugLogs) {
			this.logger.log('Auto-reply disabled (TELEGRAM_AUTO_REPLY=false); skipping DM send');
		}
	}

	private renderPrettyRelevantLog(input: {
		peerId: string;
		messageId: number;
		text: string;
		mentions: string[];
		links: string[];
		ts: Date;
		publisherUsername?: string;
	}): string {
		const sanitized = input.text.replace(/[\t\r\f\v]+/g, ' ').replace(/\s+\n/g, '\n').trim();
		// Always show full message (no truncation)
		const basePreview = sanitized;
		const tsIso = input.ts.toISOString();

		const fields = this.parseMessageFields(input.text);
		// Derive a single recruiter contact (prioritize publisher username)
		const derivedContact = this.deriveRecruiterContact(input.text, input.publisherUsername) || fields.contact;

		// Boxed, aligned layout with wrapped values
		const keyWidth = 11; // width for key column, before ':'
		const contentWidth = 70; // wrap width for values and preview
		const kvWrapped = (k: string, v: string) => this.formatKvWrapped(k, v || '—', keyWidth, contentWidth);
		const borderTop = '┌──────────── TELEGRAM MATCH ────────────┐';
		const borderMid = '├────────────────────────────────────────┤';
		const borderBot = '└────────────────────────────────────────┘';

		const lines: string[] = [
			borderTop,
			...kvWrapped('Channel', input.peerId),
			...kvWrapped('MessageId', String(input.messageId)),
			...kvWrapped('Timestamp', tsIso),
			...kvWrapped('Length', String(input.text.length)),
			borderMid,
		];

		// Job post fields
		if (fields.price) lines.push(...kvWrapped('Salary', fields.price));
		if (fields.location) lines.push(...kvWrapped('Location', fields.location));
		if (fields.workFormat) lines.push(...kvWrapped('Format', fields.workFormat));
		if (fields.employment) lines.push(...kvWrapped('Employment', fields.employment));
		if (fields.company) lines.push(...kvWrapped('Company', fields.company));
		if (derivedContact) lines.push(...kvWrapped('Contact', derivedContact));

		// Common fields
		if (fields.hashtags.length > 0) lines.push(...kvWrapped('Hashtags', fields.hashtags.join(' ')));

		lines.push(
			borderMid,
			...kvWrapped('Preview', basePreview),
			borderBot,
		);

		return lines.join('\n');
	}

	private formatKvWrapped(key: string, value: string, keyWidth: number, contentWidth: number): string[] {
		const keyPadded = key.padEnd(keyWidth);
		const wrapped = this.wrapTextForBox(value, contentWidth);
		const out: string[] = [];
		if (wrapped.length === 0) return [`│ ${keyPadded}: —`];
		out.push(`│ ${keyPadded}: ${wrapped[0] || ''}`);
		for (let i = 1; i < wrapped.length; i++) {
			out.push(`│ ${' '.repeat(keyWidth)}  ${wrapped[i]}`);
		}
		return out;
	}

	private wrapTextForBox(text: string, width: number): string[] {
		const lines: string[] = [];
		for (const rawLine of text.split('\n')) {
			const words = rawLine.trim().split(/\s+/).filter(Boolean);
			let current = '';
			for (const w of words) {
				if (current.length === 0) {
					current = w;
					continue;
				}
				if ((current + ' ' + w).length <= width) {
					current += ' ' + w;
				} else {
					lines.push(current);
					current = w;
				}
			}
			if (current.length > 0) lines.push(current);
			if (rawLine.trim().length === 0) lines.push('');
		}
		if (lines.length === 0) return [''];
		return lines;
	}

	private normalizeLlmContent(content: any): string | undefined {
		if (!content) return undefined;
		if (typeof content === 'string') return content;
		// Some models return array of segments
		if (Array.isArray(content)) {
			const parts = content
				.map((seg) => {
					if (!seg) return '';
					if (typeof seg === 'string') return seg;
					if (typeof seg?.text === 'string') return seg.text;
					if (typeof seg?.content === 'string') return seg.content;
					return '';
				})
				.filter(Boolean);
			const joined = parts.join(' ').trim();
			return joined.length > 0 ? joined : undefined;
		}
		// Generic object with possible text/content
		if (typeof content === 'object') {
			if (typeof (content as any).text === 'string') return (content as any).text;
			if (typeof (content as any).content === 'string') return (content as any).content;
		}
		return undefined;
	}

	private extractStackFromText(text: string): string[] {
		const techsBase = [
			'k8s','kubernetes','helm','terraform','ansible','docker','podman','argo','argocd','gitlab ci','github actions','jenkins','prometheus','loki','grafana','elk','efk','istio','linkerd','vault','consul','nginx','haproxy','aws','gcp','azure','yandex','gke','eks','aks','postgres','mysql','redis'
		];
		const found: string[] = [];
		for (const t of techsBase) {
			const re = new RegExp(`(?:^|[^a-zA-Z])${t.replace(/\\s+/g,'\\\\s+')}(?=$|[^a-zA-Z])`, 'i');
			if (re.test(text)) found.push(t);
		}
		return found.slice(0, 4);
	}

	private buildTemplateReply(input: { contact?: string; publisherName?: string; company?: string; position?: string; stack: string[] }): string {
		const techs = input.stack.slice(0, 2).join('/');
		const who = input.position || 'DevOps';
		const companyPart = input.company ? ` ${input.company}` : '';
		const techPart = techs ? ` ${techs}` : '';
		const greeting = input.publisherName ? `${input.publisherName}, добрый день!` : 'Добрый день!';
		return `${greeting} Интересует вакансия ${who}${companyPart}.${techPart ? ' ' + techPart : ''} Можем обсудить подробнее?`;
	}

	private buildShortReplyPrompt(input: { contact?: string; publisherName?: string; position?: string; company?: string; format?: string; location?: string; salary?: string; stack: string[]; rawText?: string; }): string {
		const stackPart = input.stack.slice(0, 3).join(', ');
		const dataParts: string[] = [];
		if (input.contact) dataParts.push(`контакт=${input.contact}`);
		if (input.publisherName) dataParts.push(`имя=${input.publisherName}`);
		if (input.position) dataParts.push(`вакансия=${input.position}`);
		if (input.company) dataParts.push(`компания=${input.company}`);
		if (input.format) dataParts.push(`формат=${input.format}`);
		if (input.location) dataParts.push(`локация=${input.location}`);
		if (input.salary) dataParts.push(`вилка=${input.salary}`);
		if (stackPart) dataParts.push(`стек=${stackPart}`);
		const dataLine = dataParts.join('; ');
		const maxChars = this.replyMaxChars || 180;
		const snippet = (input.rawText || '').trim().slice(0, 800);
		const profile = (this.candidateProfile || '').trim().slice(0, 800);
		return (
			`Ты пишешь очень короткие, живые отклики на вакансии. 1–2 предложения, максимум ${maxChars} символов. Разговорный, естественный тон (как личное сообщение), без канцелярита, без markdown и списков.\n` +
			'Требование: выведи ТОЛЬКО готовый текст сообщения без пояснений и без кавычек. Никаких слов типа "Хорошо", "Начну", "Сгенерируй".\n' +
			'Приветствие: если есть имя (имя=...), начни с "<Имя>, добрый день!". Если имени нет — начни с "Добрый день!". Не используй @ в начале.\n' +
			'Имя: если имя дано латиницей/транслитом (напр. Vitaliy, Daniil, Ruslan, Anna), используй очевидную русскую форму (Виталий, Даниил, Руслан, Анна). Исправь регистр (первая буква заглавная). Если не уверен — оставь исходное имя без @ и эмодзи.\n' +
			'Если имя похоже на название компании/бренда (например: содержит слова outstaff/agency/hr/team/group/llc/ltd/inc/компания/агентство/банк/ооо, выглядит как бренд в ВЕРХНЕМ РЕГИСТРЕ, или состоит из 4+ слов) — не используй имя, начни с "Добрый день!".\n' +
			'Формат (адаптируй по данным):\n' +
			'"Добрый день!/Имя, добрый день! Заинтересовала вакансия <должность> в компании <компания>. У меня есть обширный опыт в <2–3 основных задачах/направлениях из описания>. Можем обсудить подробнее?"\n' +
			'Выбери из описания вакансии 2–3 ключевые задачи/ответственности и сопоставь их с моим опытом/инструментами. Если уместно, добавь одно короткое достижение (цифры: %/шт/время).\n' +
			`Данные: ${dataLine}.\n` +
			(snippet ? `Короткий контекст вакансии (используй, чтобы выбрать 2–3 задачи):\n${snippet}\n` : '') +
			(profile ? `Профиль кандидата (используй для персонализации и выбора релевантных задач):\n${profile}\n` : '') +
			'Сгенерируй 1 вариант готового сообщения.'
		);
	}

	private async callLlmGenerate(prompt: string): Promise<string | undefined> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 45000);
			const doFetch: any = (globalThis as any).fetch;
			if (!doFetch) {
				this.logger.warn('LLM generation skipped: fetch is not available (require Node 18+).');
				clearTimeout(timeout);
				return undefined;
			}

			let url: string;
			let body: any;
			let headers: Record<string, string> = { 'Content-Type': 'application/json' };

			// Resolve reply-specific config with fallback to generic
			const apiType = this.replyApiType ?? this.llmApiType;
			const endpoint = this.replyEndpoint ?? this.llmEndpoint;
			const model = this.replyModel ?? this.llmModel;

			if (apiType === 'openai') {
				// OpenAI API
				if (!this.llmApiKey) {
					this.logger.warn('OpenAI API key (OPENAI_API_KEY) is required for OpenAI API type');
					clearTimeout(timeout);
					return undefined;
				}
				url = `${endpoint}/v1/chat/completions`;
				headers['Authorization'] = `Bearer ${this.llmApiKey}`;
				body = {
					model,
					messages: [
						{ role: 'system', content: 'Отвечай только готовым сообщением без пояснений, без кавычек и без эмодзи.' },
						{ role: 'user', content: prompt }
					],
					temperature: this.replyTemperature,
					max_tokens: this.replyMaxTokens,
				};
			} else {
				// Ollama API
				const isQwenVL = (model || '').toLowerCase().includes('qwen3-vl');
				if (isQwenVL) {
					url = `${endpoint}/api/chat`;
					body = {
						model,
						stream: false,
						options: { temperature: this.replyTemperature, top_p: 0.9, repeat_penalty: 1.2, num_predict: this.replyMaxTokens, stop: ['\n\n','---'] },
						messages: [
							{ role: 'system', content: 'Отвечай только готовым сообщением без пояснений, без кавычек и без эмодзи.' },
							{ role: 'user', content: prompt }
						],
					};
				} else {
					url = `${endpoint}/api/generate`;
					body = {
						model,
						stream: false,
						options: {
							temperature: this.replyTemperature,
							top_p: 0.9,
							repeat_penalty: 1.2,
							num_predict: this.replyMaxTokens,
							stop: ['\n\n','---'],
						},
						prompt,
					};
				}
			}

			const res = await doFetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			if (this.debugLogs) this.logger.log(`LLM HTTP ok: ${res.status}`);
			
			const json: any = await res.json();
			let raw: string | undefined;

			if (apiType === 'openai') {
				// OpenAI API format: response.choices[0].message.content
				raw = json?.choices?.[0]?.message?.content;
				if (!raw && json?.choices?.[0]?.text) {
					raw = json.choices[0].text;
				}
			} else {
				// Ollama API format
				const isQwenVL = (model || '').toLowerCase().includes('qwen3-vl');
				if (isQwenVL) {
					raw = this.normalizeLlmContent(json?.message?.content);
					if (!raw && typeof json?.response === 'string' && json.response) raw = json.response;
					if (!raw) raw = this.normalizeLlmContent(json?.message?.thinking);
					if (!raw && typeof json?.thinking === 'string' && json.thinking.trim().length > 0) raw = json.thinking;
				} else {
					raw = typeof json?.response === 'string' && json.response ? json.response : undefined;
					if (!raw) raw = this.normalizeLlmContent(json?.message?.content);
					if (!raw) raw = this.normalizeLlmContent(json?.thinking?.content);
					if (!raw && typeof json?.thinking === 'string' && json.thinking.trim().length > 0) raw = json.thinking;
				}
			}

			if (this.debugLogs) {
				const preview = raw ? raw.slice(0, 160).replace(/\s+/g, ' ') : 'null';
				this.logger.log(`LLM raw preview: ${preview}${raw && raw.length > 160 ? '…' : ''}`);
			}
			// Fallback: only for Ollama API (not OpenAI)
			if (!raw && apiType !== 'openai') {
				if (this.debugLogs) this.logger.log('LLM fallback: calling /api/chat');
				const chatUrl = `${endpoint}/api/chat`;
				const chatBody: any = {
					model,
					stream: false,
					options: {
						temperature: this.replyTemperature,
						top_p: 0.9,
						repeat_penalty: 1.2,
						num_predict: this.replyMaxTokens,
						stop: ['\n\n','---'],
					},
					messages: [ { role: 'user', content: prompt } ],
				};
				const chatRes = await doFetch(chatUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(chatBody),
					signal: controller.signal,
				});
				if (this.debugLogs) this.logger.log(`LLM CHAT HTTP: ${chatRes.status}`);
				if (chatRes.ok) {
					const chatJson: any = await chatRes.json();
					raw = (chatJson?.message?.content && typeof chatJson.message.content === 'string') ? chatJson.message.content : undefined;
					if (!raw && typeof chatJson?.response === 'string' && chatJson.response) raw = chatJson.response;
					if (!raw && typeof chatJson?.thinking === 'string' && chatJson.thinking.trim().length > 0) raw = chatJson.thinking;
					if (this.debugLogs) {
						const chatPreview = raw ? raw.slice(0, 160).replace(/\s+/g, ' ') : 'null';
						this.logger.log(`LLM chat preview: ${chatPreview}${raw && raw.length > 160 ? '…' : ''}`);
					}
				}
			}
			const text = raw?.trim();
			if (!text && this.debugLogs) {
				this.logger.log(`LLM empty text; generate keys=${Object.keys(json || {}).join(',') || 'none'}`);
			}
			return text ? text.replace(/\s+/g, ' ').trim() : undefined;
		} catch (e) {
			return undefined;
		}
	}

	private async extractFieldsWithLlm(text: string): Promise<{
		position?: string;
		company?: string;
		salary?: string;
		location?: string;
		workFormat?: string;
		employment?: string;
		contact?: string;
		hashtags?: string[];
		stack?: string[];
		tasks?: string[];
		summary?: string;
	} | null> {
		// Resolve extract-specific config with fallback to generic
		const apiType = this.extractApiType ?? this.llmApiType;
		const endpoint = this.extractEndpoint ?? this.llmEndpoint;
		const model = this.extractModel ?? this.llmModel;
		if (!this.llmEnabled || !endpoint || !model) {
			return null;
		}

		try {
			const prompt = `Ты эксперт по анализу текстов вакансий. Извлеки структурированные данные из текста вакансии.

ВАЖНО: Верни ТОЛЬКО валидный JSON без пояснений, без markdown, без кавычек вокруг JSON.

Требуемые поля (если не найдено - null):
- position: точное название должности
- company: название компании (без ссылок и слов "Компания:", "Company:")
- salary: зарплата/вилка в исходном формате
- location: локация/город
- workFormat: "Удалённо", "Офис", "Гибрид" (или "Remote", "On-site", "Hybrid")
- employment: "Полная", "Частичная", "Проектная" (или "Full-time", "Part-time", "Contract")
- contact: контакт рекрутера (@username или email, БЕЗ каналов @devops_jobs, @devops_jobs_feed)
- hashtags: массив хештегов БЕЗ символа #
- stack: массив всех технологий, инструментов, платформ, фреймворков и библиотек, которые упомянуты в тексте. Внимательно прочитай весь текст и найди ВСЕ упоминания технологий. Не пропускай ничего - если технология упомянута в тексте, она должна быть в списке. Извлекай точные названия как они написаны.
- tasks: массив всех основных задач и обязанностей из вакансии. Внимательно прочитай разделы с задачами и обязанностями. Извлекай каждую задачу отдельно, формулируй кратко (5-12 слов). Не объединяй несколько задач в одну - каждая задача должна быть отдельным элементом массива.
- summary: короткое саммари (2-4 предложения, до 200 символов) о том, чем предстоит заниматься в этой вакансии. Обобщи основные задачи и обязанности в краткой форме, чтобы было понятно суть работы.

Текст вакансии:
${text.substring(0, 5000)}

JSON ответ:`;

			if (this.debugLogs) {
				this.logger.log(`LLM extract start: model=${model} endpoint=${endpoint}`);
			}
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 60000); // Увеличили до 60 секунд
			const doFetch: any = (globalThis as any).fetch;
			if (!doFetch) {
				return null;
			}

			let url: string;
			let body: any;
			let headers: Record<string, string> = { 'Content-Type': 'application/json' };
			
			if (apiType === 'openai') {
				// OpenAI API
				if (!this.llmApiKey) {
					this.logger.warn('OpenAI API key (OPENAI_API_KEY) is required for OpenAI API type');
					return null;
				}
				url = `${endpoint}/v1/chat/completions`;
				headers['Authorization'] = `Bearer ${this.llmApiKey}`;
				body = {
					model,
					messages: [
						{ role: 'system', content: 'Ты извлекаешь структурированные данные из текста вакансий. Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, без кавычек вокруг JSON.' },
						{ role: 'user', content: prompt }
					],
					temperature: 0.3, // Немного увеличена для более вариативного извлечения
					max_tokens: 1400, // Увеличено для полного извлечения всех технологий, задач и саммари
				};
			} else {
				// Ollama API
				const isQwenVL = (model || '').toLowerCase().includes('qwen3-vl');
				url = isQwenVL ? `${endpoint}/api/chat` : `${endpoint}/api/generate`;
				body = isQwenVL
					? {
							model,
							stream: false,
							options: { temperature: 0.3, top_p: 0.9, num_predict: 1400 }, // Увеличено для полного извлечения всех технологий, задач и саммари
							messages: [
								{ role: 'system', content: 'Ты извлекаешь структурированные данные из текста вакансий. Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, без кавычек вокруг JSON.' },
								{ role: 'user', content: prompt }
							],
						}
					: {
							model,
							stream: false,
							options: { temperature: 0.3, top_p: 0.9, num_predict: 1400 }, // Увеличено для полного извлечения всех технологий, задач и саммари
							prompt,
						};
			}

			const res = await doFetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (!res.ok) {
				if (this.debugLogs) this.logger.warn(`LLM extract HTTP error: ${res.status}`);
				return null;
			}

			const json: any = await res.json();
			
			// Debug: log full response structure
			if (this.debugLogs) {
				this.logger.log(`LLM extract response keys: ${Object.keys(json || {}).join(', ')}`);
				if (json?.message) {
					this.logger.log(`LLM extract message keys: ${Object.keys(json.message || {}).join(', ')}`);
					if (typeof json.message === 'object') {
						this.logger.log(`LLM extract message.content type: ${typeof json.message.content}`);
					}
				}
			}
			
			let rawText: string | undefined;

			if (apiType === 'openai') {
				// OpenAI API format: response.choices[0].message.content
				rawText = json?.choices?.[0]?.message?.content;
				if (!rawText && json?.choices?.[0]?.text) {
					rawText = json.choices[0].text;
				}
			} else {
				// Ollama API format
				const isQwenVL = (model || '').toLowerCase().includes('qwen3-vl');
				if (isQwenVL) {
					// Try multiple paths for qwen3-vl
					rawText = this.normalizeLlmContent(json?.message?.content);
					if (!rawText && typeof json?.message === 'string') rawText = json.message;
					if (!rawText && typeof json?.response === 'string') rawText = json.response;
					if (!rawText && typeof json?.content === 'string') rawText = json.content;
					// Try to extract from message.role if it's an array
					if (!rawText && Array.isArray(json?.message)) {
						const lastMsg = json.message[json.message.length - 1];
						rawText = this.normalizeLlmContent(lastMsg?.content);
					}
				} else {
					rawText = typeof json?.response === 'string' ? json.response : undefined;
					if (!rawText) rawText = this.normalizeLlmContent(json?.message?.content);
					if (!rawText && typeof json?.content === 'string') rawText = json.content;
				}
			}

			if (!rawText) {
				this.logger.warn(`LLM extract: empty response. Full JSON preview: ${JSON.stringify(json).substring(0, 500)}`);
				return null;
			}
			
			if (this.debugLogs) {
				this.logger.log(`LLM extract raw text preview: ${rawText.substring(0, 200)}`);
			}

			// Clean up the response: remove markdown code blocks, extra whitespace
			let cleaned = rawText.trim();
			// Remove markdown code blocks if present
			cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
			// Remove any leading/trailing quotes
			cleaned = cleaned.replace(/^["']|["']$/g, '');
			cleaned = cleaned.trim();

			// Try to parse JSON
			try {
				const parsed = JSON.parse(cleaned);
				if (this.debugLogs) {
					this.logger.log(`LLM extract success: ${Object.keys(parsed).join(', ')}`);
				}
				return {
					position: parsed.position || undefined,
					company: parsed.company || undefined,
					salary: parsed.salary || undefined,
					location: parsed.location || undefined,
					workFormat: parsed.workFormat || undefined,
					employment: parsed.employment || undefined,
					contact: parsed.contact || undefined,
					hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : undefined,
					stack: Array.isArray(parsed.stack) ? parsed.stack : undefined,
					tasks: Array.isArray(parsed.tasks) ? parsed.tasks : undefined,
					summary: parsed.summary || undefined,
				};
			} catch (parseError) {
				if (this.debugLogs) {
					this.logger.warn(`LLM extract: JSON parse error: ${(parseError as Error).message}`);
					this.logger.warn(`LLM extract raw: ${cleaned.substring(0, 200)}`);
				}
				return null;
			}
		} catch (e: unknown) {
			if (this.debugLogs) {
				this.logger.warn(`LLM extract failed: ${(e as Error).message}`);
			}
			return null;
		}
	}

	private parseMessageFields(text: string): {
		price: string | undefined;
		hashtags: string[];
		location?: string;
		workFormat?: string;
		employment?: string;
		company?: string;
		contact?: string;
	} {
		const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
		const textLower = text.toLowerCase();

		// Salary: expanded regex for job posts (supports "от X до Y", "X-Y", "X-Y$", "фикс X", rubles, etc.)
		const salaryPatterns = [
			// Вилка: "от X до Y" или "X - Y" с валютой
			/(?:зп|зарплат|вилка|оплата|salary|оклад).*?(?:от\s+)?(\d{1,6}(?:\s?\d{3})*)\s*(?:до|–|-)\s*(\d{1,6}(?:\s?\d{3})*)\s*(?:₽|руб|р\.|usd|\$|eur|€)/i,
			// Одиночная сумма с валютой
			/(?:зп|зарплат|вилка|оплата|salary|оклад).*?(?:от\s+)?(\d{1,6}(?:\s?\d{3})*)\s*(?:₽|руб|р\.|usd|\$|eur|€)/i,
			// Формат "$X-Y" или "$X"
			/(\$\s?\d{1,6}(?:\s?\d{3})*(?:\s?-\s?\d{1,6}(?:\s?\d{3})*)?)/i,
			// Формат "X$" или "X - Y$"
			/(\d{1,6}(?:\s?\d{3})*(?:\s?-\s?\d{1,6}(?:\s?\d{3})*)?\s?\$)/i,
			// EUR/USD
			/(\d{1,6}(?:\s?\d{3})*(?:\s?-\s?\d{1,6}(?:\s?\d{3})*)?\s?(?:usd|eur|€|₾))/i,
			// "X / месяц"
			/(\d{1,6}(?:\s?\d{3})*\s?(?:\$)?\s?\/\s?месяц)/i,
		];
		let price: string | undefined;
		for (const rx of salaryPatterns) {
			const m = text.match(rx);
			if (m) {
				if (m[1] && m[2]) {
					// Вилка: собрать "X - Y валюта"
					const currency = m[0].match(/[₽рубр\.$€eur]/i)?.[0] || '';
					price = `${m[1].trim().replace(/\s/g, '')} - ${m[2].trim().replace(/\s/g, '')} ${currency}`.trim();
				} else {
					price = m[0].trim();
				}
				break;
			}
		}

		// Location: extract from structured fields like "Локация:", "Location:", "Город:", or standalone mentions
		let location = lines.find((l) => /^(?:локация|location|город|city|место|place):\s*(.+)/i.test(l));
		if (location) {
			location = location.replace(/^(?:локация|location|город|city|место|place):\s*/i, '').trim();
		} else {
			// Fallback: look for common location patterns
			const locationPattern = /(?:локация|location|город|city)[:\s]+([^\n]+)/i;
			const m = text.match(locationPattern);
			if (m && m[1]) location = m[1].trim();
		}

		// Work format: удаленка/remote/офис/hybrid
		let workFormat = lines.find((l) => /^(?:формат|format|тип\s+работы):\s*(.+)/i.test(l));
		if (workFormat) {
			workFormat = workFormat.replace(/^(?:формат|format|тип\s+работы):\s*/i, '').trim();
		} else {
			if (textLower.includes('удален') || textLower.includes('remote')) workFormat = 'Удалённо';
			else if (textLower.includes('офис') || textLower.includes('on-site')) workFormat = 'Офис';
			else if (textLower.includes('гибрид') || textLower.includes('hybrid')) workFormat = 'Гибрид';
		}

		// Employment: полная/частичная/проектная
		let employment = lines.find((l) => /^(?:занятость|employment|тип\s+занятости):\s*(.+)/i.test(l));
		if (employment) {
			employment = employment.replace(/^(?:занятость|employment|тип\s+занятости):\s*/i, '').trim();
		} else {
			if (textLower.includes('полная') || textLower.includes('full-time') || textLower.includes('fulltime')) employment = 'Полная';
			else if (textLower.includes('частичная') || textLower.includes('part-time') || textLower.includes('parttime')) employment = 'Частичная';
			else if (textLower.includes('проектн') || textLower.includes('project')) employment = 'Проектная';
		}

		// Company: extract from "Компания:", "Company:", or standalone mentions
		let company = lines.find((l) => /^(?:компания|company|организация):\s*(.+)/i.test(l));
		if (company) {
			company = company.replace(/^(?:компания|company|организация):\s*/i, '').trim();
		}

		// Contact: extract telegram username or email
		let contact: string | undefined;
		const excludedMentions = ['@devops_jobs', '@devops_jobs_feed'];
		// Prefer explicit patterns like "Telegram: @user" or "Писать @user"
		const explicitPatterns = [
			/telegram[:\s]+@([a-zA-Z0-9_]+)/i,
			/писать[:\s]+@([a-zA-Z0-9_]+)/i,
			/пиши[:\s]+@([a-zA-Z0-9_]+)/i,
			/контакт(?:ы)?[:\s]+@([a-zA-Z0-9_]+)/i,
			/для\s+связи[:\s]+@([a-zA-Z0-9_]+)/i,
		];
		for (const rx of explicitPatterns) {
			const m = text.match(rx);
			if (m && m[1]) {
				const u = `@${m[1]}`;
				if (!excludedMentions.includes(u.toLowerCase())) {
					contact = u;
					break;
				}
			}
		}
		// If still none, try first inline @mention excluding channel
		if (!contact) {
			const m = text.match(/@([a-zA-Z0-9_]+)/g) ?? [];
			const firstValid = m.map((v) => v.toLowerCase()).find((v) => !excludedMentions.includes(v));
			if (firstValid) contact = firstValid;
		}
		// If still none, convert t.me links to @username
		if (!contact) {
			const tme = text.match(/https?:\/\/t\.me\/(?:joinchat\/|c\/)?([A-Za-z0-9_]+)/i);
			if (tme && tme[1]) {
				const u = `@${tme[1]}`;
				if (!excludedMentions.includes(u.toLowerCase())) contact = u;
			}
		}
		// Lastly, allow email if no username found
		if (!contact) {
			const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
			if (emailMatch) contact = emailMatch[1];
		}

		// Hashtags: collect unique hashtags
		const hashtags = Array.from(new Set((text.match(/#[^\s#]+/g) ?? [])));

		return { price, hashtags, location, workFormat, employment, company, contact };
	}

	private async runBackfill(): Promise<void> {
		if (!this.client) return;
		if (this.channelIdentifiers.length === 0) {
			this.logger.warn('Backfill requested, but TELEGRAM_CHANNEL_IDS is empty; skipping');
			return;
		}

		const sinceTs = this.backfillSinceDays ? Date.now() - this.backfillSinceDays * 24 * 60 * 60 * 1000 : undefined;
		for (const id of this.channelIdentifiers) {
			try {
				const entity = await this.client.getEntity(id);
				// Cache username -> numeric ID mapping if this is a username identifier
				if (id.startsWith('@')) {
					try {
						const inputEntity = await this.client.getInputEntity(entity as any);
						const channelIdBig = (inputEntity as any).channelId ?? (inputEntity as any).userId;
						if (channelIdBig) {
							const numericId = typeof channelIdBig.toString === 'function' ? channelIdBig.toString() : String(channelIdBig);
							this.channelUsernameToIdCache.set(id.toLowerCase(), numericId);
							this.logger.log(`Cached channel mapping: ${id} -> ${numericId}`);
						}
					} catch (e) {
						// Fallback: try to get ID from first message
						let numericId = '';
						for await (const msg of this.client.iterMessages(entity as any, { limit: 1 })) {
							if (msg instanceof Api.Message && msg.peerId) {
								const peerIdBig = (msg.peerId as Api.PeerChannel).channelId as any;
								if (peerIdBig) {
									numericId = typeof peerIdBig.toString === 'function' ? peerIdBig.toString() : String(peerIdBig);
									this.channelUsernameToIdCache.set(id.toLowerCase(), numericId);
									this.logger.log(`Cached channel mapping (from message): ${id} -> ${numericId}`);
									break;
								}
							}
						}
						if (!numericId) {
							this.logger.warn(`Could not determine numeric ID for channel ${id}`);
						}
					}
				}
				let count = 0;
				for await (const msg of this.client.iterMessages(entity as any, { limit: this.backfillLimit })) {
					if (!(msg instanceof Api.Message)) continue;
					if (sinceTs && msg.date && (msg.date as any).getTime && (msg.date as any).getTime() < sinceTs) {
						continue;
					}
					await this.processApiMessage(msg);
					count += 1;
					await this.delay(500); // small delay to be safe
				}
				this.logger.log(`Backfill complete for ${id}: processed ${count} messages`);
				this.logStats();
			} catch (e: unknown) {
				this.logger.warn(`Backfill failed for ${id}: ${(e as Error).message}`);
			}
		}
	}

	private parseListFromConfig(key: string): string[] {
		const raw = this.configService.get<string>(key);
		if (!raw) return [];
		return raw
			.split(/[,\n;]/)
			.map((v) => v.trim())
			.filter(Boolean);
	}

	private extractMessageText(msg: Api.Message): string {
		const text = (msg.message ?? '').toString();
		return text.trim();
	}

	private extractMentions(text: string): string[] {
		const matches = text.match(/@[\w\d_]+/g) ?? [];
		const mentions = Array.from(new Set(matches.map((m) => m.toLowerCase())));
		// Filter out common channel/group mentions that are not useful for job applications
		const excludedMentions = ['@devops_jobs', '@devops_jobs_feed'];
		return mentions.filter((m) => !excludedMentions.includes(m));
	}

	private extractLinks(text: string): string[] {
		const matches = text.match(/https?:\/\/\S+/gi) ?? [];
		return Array.from(new Set(matches));
	}

	// Public method to be called by TelegramBotService: send CV to a contact with caption
	public async sendCvToContact(contactUsername: string, caption: string): Promise<{ ok: boolean; reason?: string }> {
		if (!this.client) return { ok: false, reason: 'client-not-initialized' };
		const username = (contactUsername || '').trim().replace(/^@/, '');
		if (!username) return { ok: false, reason: 'no-username' };
		if (!this.cvFilePath) return { ok: false, reason: 'no-cv-file' };
		try {
			if (this.dryRun) {
				this.logger.log(`DRY_RUN: would send CV to @${username} with caption len=${caption?.length || 0}`);
				return { ok: true };
			}
			// Resolve user
			const resolved = await this.client.invoke(new Api.contacts.ResolveUsername({ username }));
			const peer = resolved?.users?.[0] || resolved?.chats?.[0];
			if (!peer) return { ok: false, reason: 'resolve-failed' };
			// Send file with caption
			await this.client.sendFile(peer as any, {
				file: this.cvFilePath,
				caption: caption || '',
			});
			return { ok: true };
		} catch (e: unknown) {
			return { ok: false, reason: (e as Error).message };
		}
	}

	public setCvFilePath(filePath: string | undefined): void {
		this.cvFilePath = filePath;
		this.logger.log(`CV path updated: ${filePath ?? 'unset'}`);
	}

	private async getPublisherUsername(msg: Api.Message): Promise<string | undefined> {
		if (!this.client) return undefined;
		try {
			const text = this.extractMessageText(msg);
			const entities: any[] = (msg as any).entities ?? [];
			
			// First: try to find entity near "Публикатор:" text
			// Find position of "Публикатор:" in text
			const publisherMatch = text.match(/публикатор[:\s]+/i);
			if (publisherMatch && publisherMatch.index !== undefined) {
				const publisherStart = publisherMatch.index;
				const publisherEnd = publisherStart + publisherMatch[0].length;
				
				// Look for entities that start right after "Публикатор:" or within next 50 characters
				for (const e of entities) {
					const offset = e.offset ?? 0;
					const length = e.length ?? 0;
					
					// Check if entity starts near "Публикатор:" text
					if (offset >= publisherEnd && offset <= publisherEnd + 50) {
						const typeName = e?._ === undefined ? (e.constructor?.name ?? '') : e._;
						
						// MessageEntityMentionName - direct user mention
						if (typeName === 'MessageEntityMentionName' && e.userId) {
							try {
								const ent = await this.client.getEntity(e.userId);
								const username = (ent as any).username;
								if (username) {
									if (this.debugLogs) {
										this.logger.log(`Found publisher from MessageEntityMentionName: @${username}`);
									}
									return `@${username}`;
								}
							} catch {}
						}
						
						// MessageEntityTextUrl - link like tg://user?id=...
						if (typeName === 'MessageEntityTextUrl' && typeof e.url === 'string') {
							const m = e.url.match(/^tg:\/\/user\?id=(\d+)/i);
							if (m && m[1]) {
								try {
									const ent = await this.client.getEntity(Number(m[1]));
									const username = (ent as any).username;
									if (username) {
										if (this.debugLogs) {
											this.logger.log(`Found publisher from MessageEntityTextUrl: @${username}`);
										}
										return `@${username}`;
									}
								} catch {}
							}
						}
					}
				}
			}
			
			// Second: try to get username from fromId (author of the post)
			if (msg.fromId) {
				const fromId = (msg.fromId as any).userId ?? (msg.fromId as any).channelId;
				if (fromId) {
					try {
						const entity = await this.client.getEntity(fromId);
						const username = (entity as any).username;
						if (username) {
							if (this.debugLogs) {
								this.logger.log(`Found publisher from fromId: @${username}`);
							}
							return `@${username}`;
						}
					} catch {
						// Ignore errors
					}
				}
			}

			// Fallback: inspect all entities for text links to users
			if (Array.isArray(entities)) {
				for (const e of entities) {
					const typeName = e?._ === undefined ? (e.constructor?.name ?? '') : e._;
					if (typeName === 'MessageEntityMentionName' && e.userId) {
						try {
							const ent = await this.client.getEntity(e.userId);
							const username = (ent as any).username;
							if (username) return `@${username}`;
						} catch {}
					}
					if (typeName === 'MessageEntityTextUrl' && typeof e.url === 'string') {
						const m = e.url.match(/^tg:\/\/user\?id=(\d+)/i);
						if (m && m[1]) {
							try {
								const ent = await this.client.getEntity(Number(m[1]));
								const username = (ent as any).username;
								if (username) return `@${username}`;
							} catch {}
						}
					}
				}
			}
		} catch (e: unknown) {
			if (this.debugLogs) {
				this.logger.warn(`getPublisherUsername error: ${(e as Error).message}`);
			}
		}
		return undefined;
	}

	private extractPublisherFromText(text: string): string | undefined {
		// Extract from "Публикатор: ..." line - this is a clickable link to the author
		const publisherMatch = text.match(/публикатор[:\s]+([^\n]+)/i);
		if (publisherMatch && publisherMatch[1]) {
			const publisherName = publisherMatch[1].trim();
			
			// Look for contact patterns in the text, especially near the end (where contacts are usually placed)
			// Patterns: "Пиши @username", "Контакт: @username", "Telegram: @username", "Писать: @username"
			const contactPatterns = [
				/пиши[:\s]+@([a-zA-Z0-9_]+)/i,
				/контакт[:\s]+@([a-zA-Z0-9_]+)/i,
				/telegram[:\s]+@([a-zA-Z0-9_]+)/i,
				/писать[:\s]+@([a-zA-Z0-9_]+)/i,
				/написать[:\s]+@([a-zA-Z0-9_]+)/i,
				/обращаться[:\s]+@([a-zA-Z0-9_]+)/i,
			];
			
			for (const pattern of contactPatterns) {
				const match = text.match(pattern);
				if (match && match[1]) {
					const username = `@${match[1]}`;
					const excluded = ['@devops_jobs', '@devops_jobs_feed'];
					if (!excluded.includes(username.toLowerCase())) {
						return username;
					}
				}
			}
			
			// Fallback: look for any @username in the last 300 characters (where contacts usually are)
			const lastPart = text.slice(-300);
			const usernameMatches = lastPart.match(/@([a-zA-Z0-9_]+)/g);
			if (usernameMatches) {
				for (const match of usernameMatches) {
					const username = match.toLowerCase();
					const excluded = ['@devops_jobs', '@devops_jobs_feed'];
					if (!excluded.includes(username)) {
						return match;
					}
				}
			}
		}
		return undefined;
	}

	private deriveRecruiterContact(text: string, publisherUsername?: string): string | undefined {
		// First priority: extracted publisher username from message
		if (publisherUsername) {
			const excluded = ['@devops_jobs', '@devops_jobs_feed'];
			if (!excluded.includes(publisherUsername.toLowerCase())) {
				return publisherUsername;
			}
		}

		// Second priority: extract from "Публикатор: ..." text pattern
		const publisherFromText = this.extractPublisherFromText(text);
		if (publisherFromText) return publisherFromText;

		// Third priority: first non-excluded @mention
		const mentions = this.extractMentions(text);
		if (mentions.length > 0) return mentions[0];

		// Fourth priority: extract from Telegram links and convert to @username
		const links = this.extractLinks(text);
		for (const link of links) {
			const m = link.match(/^https?:\/\/t\.me\/(?:joinchat\/|c\/)?([A-Za-z0-9_]+)/i);
			if (m && m[1]) {
				const candidate = `@${m[1]}`;
				const excluded = ['@devops_jobs', '@devops_jobs_feed'];
				if (!excluded.includes(candidate.toLowerCase())) return candidate;
			}
		}
		return undefined;
	}

	private extractPublisherDisplayName(text: string): string | undefined {
		// Parse human-readable name after "Публикатор:" without @username/link
		const m = text.match(/публикатор[:\s]+([^\n]+)/i);
		if (!m || !m[1]) return undefined;
		let name = m[1]
			.replace(/https?:\/\/\S+/g, '') // remove links
			.replace(/@\w+/g, '') // remove @mentions
			.replace(/[|;]+/g, ' ')
			.trim();
		// Collapse multiple spaces
		name = name.replace(/\s{2,}/g, ' ').trim();
		// Basic sanity: keep short names only (2-40 chars)
		if (name.length < 2 || name.length > 60) return undefined;
		// Ignore if likely a company/brand, not a personal name
		if (this.isLikelyCompanyName(name)) return undefined;
		return name;
	}

	private isLikelyCompanyName(name: string): boolean {
		const n = name.trim();
		const lower = n.toLowerCase();
		// Keywords that suggest organization/brand
		const orgKeywords = [
			'outstaff','outsourcing','recruit','recruitment','agency','hr','group','team','studio','bank','labs','digital','solutions','systems','partners','consult','it','dev','soft','tech','llc','ltd','inc','corp','company','компания','агентство','студия','банк','группа','ооо','ооо «','ооо"','ип','зао','оао'
		];
		if (orgKeywords.some(k => lower.includes(k))) return true;
		// Has digits or looks like a handle/path
		if (/[0-9]/.test(n)) return true;
		// Too many words or ALL CAPS words typical for brands
		const words = n.split(/\s+/).filter(Boolean);
		if (words.length > 4) return true;
		const hasAllCaps = words.some(w => w.length > 2 && /^[A-ZА-ЯЁ0-9\-]+$/.test(w));
		if (hasAllCaps) return true;
		// Ends with common company suffix
		const suffixes = [' llc',' ltd',' inc',' corp',' company',' bank',' group',' team'];
		if (suffixes.some(s => lower.endsWith(s))) return true;
		return false;
	}

	private normalizePublisherNameToRussian(name: string | undefined): string | undefined {
		if (!name) return undefined;
		let n = name.trim();
		// Use first token (given name) only
		const first = n.split(/\s+/).filter(Boolean)[0] || '';
		if (!first) return undefined;
		// Ignore if looks like a handle
		if (/[@#]/.test(first)) return undefined;
		// Strip punctuation/emojis
		const cleaned = first.replace(/[\p{P}\p{S}]+/gu, '');
		if (!cleaned) return undefined;
		// If Cyrillic, just Title Case
		if (/[А-Яа-яЁё]/.test(cleaned)) {
			const out = cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
			return out;
		}
		// Latin → known mappings to Russian (formal where possible)
		const lower = cleaned.toLowerCase();
		const map: Record<string, string> = {
			// female
			'liz': 'Елизавета', 'liza': 'Елизавета', 'lizzy': 'Елизавета', 'elizabeth': 'Елизавета', 'elizaveta': 'Елизавета',
			'lisa': 'Елизавета', 'beth': 'Елизавета',
			'anna': 'Анна', 'ann': 'Анна', 'anne': 'Анна', 'annie': 'Анна',
			'irina': 'Ирина', 'ira': 'Ирина',
			'ekaterina': 'Екатерина', 'katherine': 'Екатерина', 'kate': 'Екатерина', 'katya': 'Екатерина', 'catherine': 'Екатерина',
			'olga': 'Ольга', 'olya': 'Ольга',
			'tatiana': 'Татьяна', 'tanya': 'Татьяна',
			'natalia': 'Наталия', 'natalya': 'Наталья', 'natalie': 'Наталия', 'natasha': 'Наталья',
			'victoria': 'Виктория', 'viktoria': 'Виктория', 'vicki': 'Виктория', 'vicky': 'Виктория',
			'maria': 'Мария', 'mary': 'Мария', 'masha': 'Мария',
			'elena': 'Елена', 'helen': 'Елена', 'lena': 'Елена',
			'ksenia': 'Ксения', 'xenia': 'Ксения', 'ksusha': 'Ксения',
			'ludmila': 'Людмила', 'lyudmila': 'Людмила', 'luda': 'Людмила',
			'galina': 'Галина', 'galya': 'Галина',
			'anastasia': 'Анастасия', 'anastasiya': 'Анастасия', 'stacey': 'Анастасия', 'stacy': 'Анастасия', 'nastya': 'Анастасия',
			'julia': 'Юлия', 'yulia': 'Юлия', 'juliya': 'Юлия', 'ulia': 'Юлия', 'julie': 'Юлия',
			'lyubov': 'Любовь', 'love': 'Любовь',
			// male
			'vitaliy': 'Виталий', 'vitaly': 'Виталий', 'vitali': 'Виталий',
			'daniil': 'Даниил', 'danil': 'Данил', 'daniel': 'Даниил', 'dan': 'Даниил',
			'ruslan': 'Руслан',
			'michael': 'Михаил', 'mike': 'Михаил', 'mikhail': 'Михаил',
			'alexander': 'Александр', 'alex': 'Александр', 'sasha': 'Александр',
			'andrei': 'Андрей', 'andrey': 'Андрей', 'andrew': 'Андрей',
			'nikita': 'Никита', 'nik': 'Никита',
			'ivan': 'Иван', 'john': 'Иван',
			'konstantin': 'Константин', 'kostya': 'Константин',
			'pavel': 'Павел', 'paul': 'Павел',
			'roman': 'Роман', 'rom': 'Роман',
			'egor': 'Егор', 'george': 'Георгий', 'georgy': 'Георгий',
			'oleg': 'Олег',
			'ilya': 'Илья', 'eli': 'Илья',
			'kiril': 'Кирилл', 'kirill': 'Кирилл', 'cyril': 'Кирилл',
			'anton': 'Антон', 'tony': 'Антон'
		};
		const mapped = map[lower];
		if (mapped) return mapped;
		// Title-case fallback for unknown latin names (keep as-is but capitalized)
		return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
	}

	private hasKeywordMatch(text: string): boolean {
		// Extract all hashtags from text (words starting with #)
		const hashtags = text.match(/#[\w\d\u0400-\u04FF]+/g) ?? [];
		const lowerHashtags = hashtags.map((h) => h.toLowerCase());
		
		if (this.debugLogs && hashtags.length > 0) {
			this.logger.log(`HASHTAGS found: [${hashtags.join(', ')}]`);
		}
		
		// Check if any of the required keywords (as hashtags) are present
		const matched = this.keywords.some((keyword) => {
			const hashtagKeyword = keyword.startsWith('#') ? keyword.toLowerCase() : `#${keyword.toLowerCase()}`;
			const found = lowerHashtags.includes(hashtagKeyword);
			if (this.debugLogs && found) {
				this.logger.log(`MATCH: found hashtag ${hashtagKeyword} in message`);
			}
			return found;
		});
		
		return matched;
	}

	private logStats(): void {
		const { totalProcessed, skippedNoKeyword, skippedDuplicate, skippedNotAllowed, successfullyProcessed } = this.stats;
		const processed = totalProcessed - skippedNotAllowed;
		this.logger.log(`STATS: total=${totalProcessed} processed=${processed} success=${successfullyProcessed} skipped: no-keyword=${skippedNoKeyword} duplicate=${skippedDuplicate} not-allowed=${skippedNotAllowed}`);
	}

	private async isChannelAllowed(msg: Api.Message): Promise<boolean> {
		if (this.channelIdentifiers.length === 0) return true;
		try {
			if (!this.client) return false;

			const rawPeerIdBig = (msg.peerId as Api.PeerChannel).channelId as any;
			const rawPeerIdStr = rawPeerIdBig ? (typeof rawPeerIdBig.toString === 'function' ? rawPeerIdBig.toString() : String(rawPeerIdBig)) : '';

			// Check if we have username-based identifiers (start with @)
			const usernameIdentifiers = this.channelIdentifiers.filter((id) => id.startsWith('@'));

			// Check cache first: if we've seen this numeric ID before for a username identifier
			if (usernameIdentifiers.length > 0) {
				for (const usernameId of usernameIdentifiers) {
					const cachedId = this.channelUsernameToIdCache.get(usernameId);
					if (cachedId && cachedId === rawPeerIdStr) {
						return true;
					}
				}
			}

			// Check direct numeric ID match
			if (this.channelIdentifiers.includes(rawPeerIdStr)) {
				return true;
			}

			// Try to resolve username and cache it
			if (usernameIdentifiers.length > 0) {
				try {
					const inputPeer = await this.client.getInputEntity(msg.peerId as any);
					const username = (inputPeer as any).username ? `@${(inputPeer as any).username}`.toLowerCase() : undefined;
					if (username && usernameIdentifiers.includes(username)) {
						// Cache the mapping for future use
						this.channelUsernameToIdCache.set(username, rawPeerIdStr);
						return true;
					}
					// Also check resolved channelId (might be different format)
					const channelIdBig = (inputPeer as any).channelId ?? (inputPeer as any).userId;
					const idStr = channelIdBig ? (typeof channelIdBig.toString === 'function' ? channelIdBig.toString() : String(channelIdBig)) : '';
					if (idStr && usernameIdentifiers.some((uid) => this.channelUsernameToIdCache.get(uid) === idStr)) {
						return true;
					}
				} catch (e) {
					if (this.debugLogs) {
						this.logger.log(`ALLOW username resolution failed: ${(e as Error).message}`);
					}
				}
			}

			if (this.debugLogs) {
				this.logger.log(`ALLOW check: rawPeerIdStr=${rawPeerIdStr} allowed=${this.channelIdentifiers.join(',')} cache=${Array.from(this.channelUsernameToIdCache.entries()).map(([k, v]) => `${k}=>${v}`).join(',') || 'empty'} - no match`);
			}
			return false;
		} catch {
			return false;
		}
	}

	private async markProcessedOnce(peerId: string, messageId: number): Promise<boolean> {
		const client = this.redisService.getClient();
		const key = `userbot:processed:${peerId}:${messageId}`;
		const ttlSec = 7 * 24 * 60 * 60;
		try {
			const set = await client.set(key, '1', { NX: true, EX: ttlSec });
			return set === 'OK';
		} catch (e: unknown) {
			this.logger.warn(`Redis error on markProcessedOnce: ${(e as Error).message}`);
			return true; // fail open to avoid missing messages
		}
	}

	private renderReply(digest: { text: string; mentions: string[]; links: string[] }): string {
		return this.replyTemplate
			.replace(/\{\{\s*ORIGINAL\s*\}\}/gi, digest.text)
			.replace(/\{\{\s*MENTIONS\s*\}\}/gi, digest.mentions.join(', ') || '—')
			.replace(/\{\{\s*LINKS\s*\}\}/gi, digest.links.join('\n') || '—');
	}

	private async sendDmReplies(
		digest: { text: string; mentions: string[]; links: string[] },
		peerId: string,
		messageId: number,
		llmReplyText?: string,
		replyData?: { contact?: string; position?: string; company?: string; format?: string; location?: string; salary?: string; stack: string[] }
	): Promise<void> {
		if (!this.client) return;

		// Resolve candidate usernames from mentions and t.me links
		const fromLinks = digest.links
			.map((l) => {
				try {
					const url = new URL(l);
					if (url.hostname === 't.me' || url.hostname === 'telegram.me') {
						const username = url.pathname.replace(/^\//, '');
						if (username && /^[A-Za-z0-9_]+$/.test(username)) return `@${username}`.toLowerCase();
					}
				} catch { /* no-op */ }
				return undefined;
			})
			.filter((v): v is string => Boolean(v));

		const uniqueTargets = Array.from(new Set([...digest.mentions, ...fromLinks])).slice(0, this.dmMaxPerPost);
		if (uniqueTargets.length === 0) return;

		let dmSent = false;
		for (const username of uniqueTargets) {
			await this.delay(this.dmDelayMs);
			try {
				const entity = await this.client.getEntity(username);
				
				// Generate reply: prefer LLM if available, fallback to template
				let payload: string | undefined;
				
				if (llmReplyText) {
					// Use pre-generated LLM reply
					payload = llmReplyText;
				} else if (this.llmEnabled && this.llmEndpoint && this.llmModel && replyData) {
					// Generate on-the-fly with LLM
					try {
						const contactForPrompt = replyData.contact || username;
						const prompt = this.buildShortReplyPrompt({
							contact: contactForPrompt,
							position: replyData.position,
							company: replyData.company,
							format: replyData.format,
							location: replyData.location,
							salary: replyData.salary,
							stack: replyData.stack,
						});
						const generated = await this.callLlmGenerate(prompt);
						if (generated && generated.trim().startsWith(contactForPrompt)) {
							payload = generated;
						}
					} catch (e: unknown) {
						this.logger.warn(`LLM generation for DM failed: ${(e as Error).message}`);
					}
				}
				
				// Fallback to template if LLM didn't work
				if (!payload && this.replyTemplate) {
					payload = this.renderReply(digest);
				}
				
				// If still no payload, skip this target
				if (!payload) {
					this.logger.warn(`No reply payload available for ${username}, skipping`);
					continue;
				}
				
				if (this.dryRun) {
					this.logger.log(`DRY_RUN: would DM ${username} with payload length=${payload.length}`);
					continue;
				}
				await this.client.sendMessage(entity as any, { message: payload });
				this.logger.log(`DM sent to ${username}`);
				dmSent = true;
			} catch (e: unknown) {
				this.logger.warn(`Failed to DM ${username}: ${(e as Error).message}`);
			}
		}

		// Update vacancy status if DM was sent
		if (dmSent) {
			try {
				await this.vacancyRepository.update(
					{ channelId: peerId, messageId },
					{ dmSent: true, status: 'sent' },
				);
				if (this.debugLogs) {
					this.logger.log(`Vacancy updated: channelId=${peerId} messageId=${messageId} status=sent`);
				}
			} catch (e: unknown) {
				this.logger.warn(`Failed to update vacancy status: ${(e as Error).message}`);
			}
		}
	}

	private async delay(ms: number): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, ms));
	}
}


