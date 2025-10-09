import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService {
	private readonly logger = new Logger(RedisService.name);
	private client: RedisClientType;
	constructor(private configService: ConfigService) {
		const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
		const redisPort = this.configService.get<number>('REDIS_PORT', 6379);
		const redisPassword = this.configService.get<string>('REDIS_PASSWORD');
		const redisDb = this.configService.get<number>('REDIS_DB', 0);

		this.logger.log(`Connecting to Redis at ${redisHost}:${redisPort}`);

		this.client = createClient({
			socket: {
				host: redisHost,
				port: redisPort,
				connectTimeout: 5000,
			},
			password: redisPassword,
			database: redisDb,
		});

		this.client.on('error', (error) => {
			this.logger.error(`Redis connection error: ${error.message}`);
		});

		this.client.on('connect', () => {
			this.logger.log('Connected to Redis');
		});

		this.client.on('ready', () => {
			this.logger.log('Redis client is ready');
		});

		this.client.on('end', () => {
			this.logger.log('Redis connection ended');
		});
	}

	async onModuleInit() {
		try {
			await this.client.connect();
			this.logger.log('Redis client initialized successfully');
		} catch (error) {
			this.logger.error(`Failed to initialize Redis client: ${error.message}`);
		}
	}

	async onModuleDestroy() {
		try {
			await this.client.quit();
			this.logger.log('Redis client disconnected');
		} catch (error) {
			this.logger.error(`Error disconnecting Redis client: ${error.message}`);
		}
	}

	async ping(): Promise<boolean> {
		try {
			if (!this.client.isOpen) {
				this.logger.warn('Redis client is not connected');
				return false;
			}

			const result = await this.client.ping();
			return result === 'PONG';
		} catch (error) {
			this.logger.error(`Redis ping failed: ${error.message}`);
			return false;
		}
	}

	getClient(): RedisClientType {
		return this.client;
	}
}