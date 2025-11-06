import { Controller, Get, Logger, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { MetricsService } from './metrics/metrics.service';
import { Response } from 'express';

@Controller()
export class AppController {
	private readonly logger = new Logger(AppController.name);

	constructor(
		private readonly appService: AppService,
		private readonly metricsService: MetricsService,
	) { }

	@Get()
	getHello(): string {
		return this.appService.getHello();
	}

	@Get('redis')
	async getRedisHealth(): Promise<{ status: boolean; message?: string; }> {
		this.logger.log('Redis health check endpoint accessed');
		return this.appService.checkRedisHealth();
	}

	@Get('metrics')
	async getMetrics(@Res() res: Response): Promise<void> {
		const metrics = await this.metricsService.getMetrics();
		res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
		res.send(metrics);
	}
}
