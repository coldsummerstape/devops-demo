import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { createClient, RedisClientType } from 'redis';

jest.mock('redis', () => ({
	createClient: jest.fn(),
}));

describe('RedisService', () => {
	let service: RedisService;
	let configService: ConfigService;
	let mockClient: jest.Mocked<RedisClientType>;

	beforeEach(async () => {
		mockClient = {
			isOpen: true,
			ping: jest.fn().mockResolvedValue('PONG'),
			connect: jest.fn().mockResolvedValue(undefined),
			quit: jest.fn().mockResolvedValue(undefined),
			on: jest.fn(),
		} as any;

		(createClient as jest.Mock).mockReturnValue(mockClient);

		const module: TestingModule = await Test.createTestingModule({
			providers: [
				RedisService,
				{
					provide: ConfigService,
					useValue: {
						get: jest.fn((key: string, defaultValue?: any) => {
							const config: Record<string, any> = {
								REDIS_HOST: 'localhost',
								REDIS_PORT: 6379,
								REDIS_DB: 0,
							};
							return config[key] ?? defaultValue;
						}),
					},
				},
			],
		}).compile();

		service = module.get<RedisService>(RedisService);
		configService = module.get<ConfigService>(ConfigService);
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	it('should be defined', () => {
		expect(service).toBeDefined();
	});

	describe('ping', () => {
		it('should return true when Redis responds with PONG', async () => {
			const mockPing = jest.fn().mockResolvedValue('PONG');
			Object.defineProperty(mockClient, 'isOpen', { value: true, writable: true, configurable: true });
			Object.defineProperty(mockClient, 'ping', { value: mockPing, writable: true, configurable: true });

			const result = await service.ping();

			expect(result).toBe(true);
			expect(mockPing).toHaveBeenCalled();
		});

		it('should return false when Redis is not connected', async () => {
			Object.defineProperty(mockClient, 'isOpen', { value: false, writable: true, configurable: true });

			const result = await service.ping();

			expect(result).toBe(false);
		});

		it('should return false when Redis ping throws error', async () => {
			const mockPing = jest.fn().mockRejectedValue(new Error('Connection failed'));
			Object.defineProperty(mockClient, 'isOpen', { value: true, writable: true, configurable: true });
			Object.defineProperty(mockClient, 'ping', { value: mockPing, writable: true, configurable: true });

			const result = await service.ping();

			expect(result).toBe(false);
			expect(mockPing).toHaveBeenCalled();
		});

		it('should return false when Redis responds with non-PONG', async () => {
			const mockPing = jest.fn().mockResolvedValue('ERROR');
			Object.defineProperty(mockClient, 'isOpen', { value: true, writable: true, configurable: true });
			Object.defineProperty(mockClient, 'ping', { value: mockPing, writable: true, configurable: true });

			const result = await service.ping();

			expect(result).toBe(false);
			expect(mockPing).toHaveBeenCalled();
		});
	});

	describe('getClient', () => {
		it('should return Redis client', () => {
			const client = service.getClient();

			expect(client).toBe(mockClient);
		});
	});

	describe('onModuleInit', () => {
		it('should connect to Redis', async () => {
			await service.onModuleInit();

			expect(mockClient.connect).toHaveBeenCalled();
		});

		it('should handle connection errors', async () => {
			mockClient.connect = jest.fn().mockRejectedValue(new Error('Connection failed'));

			await expect(service.onModuleInit()).resolves.not.toThrow();
			expect(mockClient.connect).toHaveBeenCalled();
		});
	});

	describe('onModuleDestroy', () => {
		it('should disconnect from Redis', async () => {
			await service.onModuleDestroy();

			expect(mockClient.quit).toHaveBeenCalled();
		});

		it('should handle disconnection errors', async () => {
			mockClient.quit = jest.fn().mockRejectedValue(new Error('Disconnect failed'));

			await expect(service.onModuleDestroy()).resolves.not.toThrow();
			expect(mockClient.quit).toHaveBeenCalled();
		});
	});
});

