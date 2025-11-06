import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Vacancy } from './vacancy.entity';

@Module({
	imports: [
		TypeOrmModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: (configService: ConfigService) => ({
				type: 'postgres',
				host: configService.get<string>('DB_HOST', 'localhost'),
				port: configService.get<number>('DB_PORT', 5432),
				username: configService.get<string>('DB_USER', 'postgres'),
				password: configService.get<string>('DB_PASSWORD', 'postgres'),
				database: configService.get<string>('DB_NAME', 'devops_demo'),
				entities: [Vacancy],
				synchronize: configService.get<string>('DB_SYNC', 'false').toLowerCase() === 'true', // Only for dev
				logging: configService.get<string>('DB_LOGGING', 'false').toLowerCase() === 'true',
			}),
			inject: [ConfigService],
		}),
		TypeOrmModule.forFeature([Vacancy]),
	],
	exports: [TypeOrmModule],
})
export class DatabaseModule {}

