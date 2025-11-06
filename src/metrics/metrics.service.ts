import { Injectable, OnModuleInit } from '@nestjs/common';
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
	private readonly register: Registry;

	// Vacancy metrics
	public readonly vacanciesProcessedTotal: Counter<string>;
	public readonly vacanciesByStatus: Gauge<string>;
	public readonly vacanciesDmSentTotal: Counter<string>;
	public readonly vacancyProcessingDurationSeconds: Histogram<string>;
	public readonly vacanciesErrorsTotal: Counter<string>;
	public readonly vacanciesTotal: Gauge<string>;

	// Vacancy statistics metrics
	public readonly vacanciesByLocation: Gauge<string>;
	public readonly vacanciesByWorkFormat: Gauge<string>;
	public readonly vacanciesByEmployment: Gauge<string>;
	public readonly vacanciesBySalaryRange: Gauge<string>;
	public readonly vacanciesByCompany: Gauge<string>;
	public readonly vacanciesByTechnology: Gauge<string>;

	// LLM metrics
	public readonly llmRequestsTotal: Counter<string>;
	public readonly llmRequestDurationSeconds: Histogram<string>;
	public readonly llmErrorsTotal: Counter<string>;

	// Telegram bot metrics
	public readonly telegramBotCommandsTotal: Counter<string>;
	public readonly telegramBotCallbacksTotal: Counter<string>;

	constructor() {
		this.register = new Registry();

		// Collect default Node.js metrics (CPU, memory, etc.)
		collectDefaultMetrics({ register: this.register });

		// Vacancy metrics
		this.vacanciesProcessedTotal = new Counter({
			name: 'vacancies_processed_total',
			help: 'Total number of vacancies processed',
			labelNames: ['status'],
			registers: [this.register],
		});

		this.vacanciesByStatus = new Gauge({
			name: 'vacancies_by_status',
			help: 'Number of vacancies by status',
			labelNames: ['status'],
			registers: [this.register],
		});

		this.vacanciesDmSentTotal = new Counter({
			name: 'vacancies_dm_sent_total',
			help: 'Total number of DM messages sent',
			registers: [this.register],
		});

		this.vacancyProcessingDurationSeconds = new Histogram({
			name: 'vacancy_processing_duration_seconds',
			help: 'Duration of vacancy processing in seconds',
			buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
			registers: [this.register],
		});

		this.vacanciesErrorsTotal = new Counter({
			name: 'vacancies_errors_total',
			help: 'Total number of errors during vacancy processing',
			labelNames: ['error_type'],
			registers: [this.register],
		});

		this.vacanciesTotal = new Gauge({
			name: 'vacancies_total',
			help: 'Total number of vacancies in database',
			registers: [this.register],
		});

		// Vacancy statistics metrics
		this.vacanciesByLocation = new Gauge({
			name: 'vacancies_by_location',
			help: 'Number of vacancies by location',
			labelNames: ['location'],
			registers: [this.register],
		});

		this.vacanciesByWorkFormat = new Gauge({
			name: 'vacancies_by_work_format',
			help: 'Number of vacancies by work format',
			labelNames: ['work_format'],
			registers: [this.register],
		});

		this.vacanciesByEmployment = new Gauge({
			name: 'vacancies_by_employment',
			help: 'Number of vacancies by employment type',
			labelNames: ['employment'],
			registers: [this.register],
		});

		this.vacanciesBySalaryRange = new Gauge({
			name: 'vacancies_by_salary_range',
			help: 'Number of vacancies by salary range (normalized)',
			labelNames: ['salary_range'],
			registers: [this.register],
		});

		this.vacanciesByCompany = new Gauge({
			name: 'vacancies_by_company',
			help: 'Number of vacancies by company',
			labelNames: ['company'],
			registers: [this.register],
		});

		this.vacanciesByTechnology = new Gauge({
			name: 'vacancies_by_technology',
			help: 'Number of vacancies mentioning specific technology',
			labelNames: ['technology'],
			registers: [this.register],
		});

		// LLM metrics
		this.llmRequestsTotal = new Counter({
			name: 'llm_requests_total',
			help: 'Total number of LLM requests',
			labelNames: ['type'], // 'extract' or 'reply'
			registers: [this.register],
		});

		this.llmRequestDurationSeconds = new Histogram({
			name: 'llm_request_duration_seconds',
			help: 'Duration of LLM requests in seconds',
			labelNames: ['type'],
			buckets: [0.5, 1, 2, 5, 10, 30, 60],
			registers: [this.register],
		});

		this.llmErrorsTotal = new Counter({
			name: 'llm_errors_total',
			help: 'Total number of LLM errors',
			labelNames: ['type', 'error_type'],
			registers: [this.register],
		});

		// Telegram bot metrics
		this.telegramBotCommandsTotal = new Counter({
			name: 'telegram_bot_commands_total',
			help: 'Total number of Telegram bot commands received',
			labelNames: ['command'],
			registers: [this.register],
		});

		this.telegramBotCallbacksTotal = new Counter({
			name: 'telegram_bot_callbacks_total',
			help: 'Total number of Telegram bot callback queries',
			labelNames: ['action'],
			registers: [this.register],
		});
	}

	onModuleInit() {
		// Metrics are already initialized in constructor
	}

	async getMetrics(): Promise<string> {
		return this.register.metrics();
	}

	getRegister(): Registry {
		return this.register;
	}
}

