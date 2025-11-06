import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('AppController (e2e)', () => {
	let app: INestApplication;

	beforeAll(async () => {
		const moduleFixture: TestingModule = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleFixture.createNestApplication();
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	it('/ (GET)', () => {
		return request(app.getHttpServer())
			.get('/')
			.expect(200)
			.expect('Hello World!');
	});

	it('/redis (GET)', () => {
		return request(app.getHttpServer())
			.get('/redis')
			.expect(200)
			.expect((res) => {
				expect(res.body).toHaveProperty('status');
				expect(typeof res.body.status).toBe('boolean');
				if (res.body.message) {
					expect(typeof res.body.message).toBe('string');
				}
			});
	});
});

