import { IsString, MinLength } from 'class-validator';

export class ConfirmDto {
  @IsString()
  @MinLength(1)
  toolCallId!: string;
}
