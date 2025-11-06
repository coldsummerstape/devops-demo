import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';

describe('AppService', () => {
	let service: AppService;
	let redisService: RedisService;

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			providers: [
				AppService,
				{
					provide: RedisService,
					useValue: {
						ping: jest.fn(),
					},
				},
			],
		}).compile();

		service = module.get<AppService>(AppService);
		redisService = module.get<RedisService>(RedisService);
	});

	it('should be defined', () => {
		expect(service).toBeDefined();
	});

	describe('getHello', () => {
		it('should return "Hello World!"', () => {
			expect(service.getHello()).toBe('Hello World!');
		});
	});

	describe('checkRedisHealth', () => {
		it('should return healthy status when Redis ping succeeds', async () => {
			jest.spyOn(redisService, 'ping').mockResolvedValue(true);

			const result = await service.checkRedisHealth();

			expect(result).toEqual({
				status: true,
				message: 'Redis connection is healthy',
			});
			expect(redisService.ping).toHaveBeenCalled();
		});

		it('should return unhealthy status when Redis ping fails', async () => {
			jest.spyOn(redisService, 'ping').mockResolvedValue(false);

			const result = await service.checkRedisHealth();

			expect(result).toEqual({
				status: false,
				message: 'Redis ping failed',
			});
			expect(redisService.ping).toHaveBeenCalled();
		});

		it('should return unhealthy status when Redis ping throws error', async () => {
			const error = new Error('Connection failed');
			jest.spyOn(redisService, 'ping').mockRejectedValue(error);

			const result = await service.checkRedisHealth();

			expect(result).toEqual({
				status: false,
				message: 'Redis connection error: Connection failed',
			});
			expect(redisService.ping).toHaveBeenCalled();
		});
	});
});

