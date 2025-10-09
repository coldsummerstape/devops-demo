import { Controller, Get, Logger } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
	private readonly logger = new Logger(AppController.name);

	constructor(private readonly appService: AppService) { }

	@Get()
	getHello(): string {
		return this.appService.getHello();
	}

	@Get('redis')
	async getRedisHealth(): Promise<{ status: boolean; message?: string; }> {
		this.logger.log('Redis health check endpoint accessed');
		return this.appService.checkRedisHealth();
	}
}
