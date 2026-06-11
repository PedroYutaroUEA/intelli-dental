import { Module } from '@nestjs/common';
import { ModelGatewayService } from './model-gateway.service';
import { OllamaService } from './ollama.service';

@Module({
  providers: [ModelGatewayService, OllamaService],
  exports: [ModelGatewayService, OllamaService],
})
export class ModelsModule {}
