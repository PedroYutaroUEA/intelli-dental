import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { ConfirmDto } from './confirm.dto';

export class AgentRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConfirmDto)
  confirm?: ConfirmDto;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}
