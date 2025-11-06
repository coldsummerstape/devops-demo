import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserbotService } from './userbot.service';
import { RedisModule } from '../redis/redis.module';
import { Vacancy } from '../database/vacancy.entity';

@Module({
	imports: [ConfigModule, RedisModule, TypeOrmModule.forFeature([Vacancy])],
	providers: [UserbotService],
	exports: [UserbotService],
})
export class UserbotModule { }


