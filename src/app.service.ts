import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from './redis/redis.service';

@Injectable()
export class AppService {
	private readonly logger = new Logger(AppService.name);
	constructor(private readonly redisService: RedisService) { }
	
	getHello(): string {
		return 'Hello World!';
	}

	async checkRedisHealth(): Promise<{ status: boolean; message?: string; }> {
		try {
			const isConnected = await this.redisService.ping();

			if (isConnected) {
				this.logger.log('Redis health check passed');
				return { status: true, message: 'Redis connection is healthy' };
			} else {
				this.logger.warn('Redis health check failed - ping returned false');
				return { status: false, message: 'Redis ping failed' };
			}
		} catch (error) {
			this.logger.error(`Redis health check failed: ${error.message}`);
			return {
				status: false,
				message: `Redis connection error: ${error.message}`
			};
		}
	}
}
