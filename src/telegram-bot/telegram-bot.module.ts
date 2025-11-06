import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramBotService } from './telegram-bot.service';
import { Vacancy } from '../database/vacancy.entity';
import { UserbotModule } from '../userbot/userbot.module';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([Vacancy]), UserbotModule],
	providers: [TelegramBotService],
	exports: [TelegramBotService],
})
export class TelegramBotModule {}

