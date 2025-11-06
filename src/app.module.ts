import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';
import { RedisModule } from './redis/redis.module';
import { UserbotModule } from './userbot/userbot.module';
import { DatabaseModule } from './database/database.module';
import { TelegramBotModule } from './telegram-bot/telegram-bot.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
		}),
		MetricsModule,
		DatabaseModule,
		RedisModule,
		UserbotModule,
		TelegramBotModule,
	],
	controllers: [AppController],
	providers: [AppService, RedisService],
})
export class AppModule { }
