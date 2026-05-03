import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import * as start from './start.js';
import * as stop from './stop.js';
import * as status from './status.js';

export interface SlashCommand {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const commands: SlashCommand[] = [start, stop, status];

export const commandsByName = new Map<string, SlashCommand>(
  commands.map((c) => [c.data.name, c]),
);
