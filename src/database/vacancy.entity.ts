import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('vacancies')
@Index(['channelId', 'messageId'], { unique: true })
export class Vacancy {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'varchar', length: 255 })
	channelId: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	channelUsername?: string;

	@Column({ type: 'bigint' })
	messageId: number;

	@Column({ type: 'text' })
	fullText: string;

	// Parsed fields
	@Column({ type: 'varchar', length: 255, nullable: true })
	position?: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	company?: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	salary?: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	location?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	workFormat?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	employment?: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	contact?: string;

	@Column({ type: 'text', array: true, default: '{}' })
	hashtags: string[];

	@Column({ type: 'text', array: true, default: '{}' })
	stack: string[];

	// Основные задачи/требования из вакансии (извлечены LLM)
	@Column({ type: 'text', array: true, default: '{}' })
	tasks: string[];

	// Краткое саммари задач (извлечено LLM)
	@Column({ type: 'text', nullable: true })
	summary?: string;

	// LLM-generated reply
	@Column({ type: 'text', nullable: true })
	llmReply?: string;

	// Status
	@Column({ type: 'varchar', length: 50, default: 'processed' })
	status: string; // 'processed', 'sent', 'skipped', 'error'

	@Column({ type: 'boolean', default: false })
	dmSent: boolean;

	@Column({ type: 'timestamp', nullable: true })
	processedAt?: Date;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	createdAt: Date; // Date when message was published in Telegram (not when processed by bot)

	@UpdateDateColumn()
	updatedAt: Date;
}

