import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MetricsService } from './metrics/metrics.service';

describe('AppController', () => {
	let controller: AppController;
	let service: AppService;

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			controllers: [AppController],
			providers: [
				{
					provide: AppService,
					useValue: {
						getHello: jest.fn(),
						checkRedisHealth: jest.fn(),
					},
				},
				{
					provide: MetricsService,
					useValue: {
						getMetrics: jest.fn().mockResolvedValue('# HELP test_metric Test metric\n# TYPE test_metric counter\ntest_metric 1\n'),
					},
				},
			],
		}).compile();

		controller = module.get<AppController>(AppController);
		service = module.get<AppService>(AppService);
	});

	it('should be defined', () => {
		expect(controller).toBeDefined();
	});

	describe('getHello', () => {
		it('should return "Hello World!"', () => {
			jest.spyOn(service, 'getHello').mockReturnValue('Hello World!');

			const result = controller.getHello();

			expect(result).toBe('Hello World!');
			expect(service.getHello).toHaveBeenCalled();
		});
	});

	describe('getRedisHealth', () => {
		it('should return Redis health status', async () => {
			const mockHealth = { status: true, message: 'Redis connection is healthy' };
			jest.spyOn(service, 'checkRedisHealth').mockResolvedValue(mockHealth);

			const result = await controller.getRedisHealth();

			expect(result).toEqual(mockHealth);
			expect(service.checkRedisHealth).toHaveBeenCalled();
		});
	});
});

