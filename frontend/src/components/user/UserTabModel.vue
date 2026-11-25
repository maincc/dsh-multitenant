<!-- 模型配置 tab（P3 拆分自 UserCenter）：提供方卡列表 + custom 增删 + 探测。
     域状态走 useUserModel 单例；保存链路的钱包验证经壳注入的 signChallenge。 -->
<script setup>
import { toast } from '../../composables/useDialog'
import { shortAddress } from '../../utils/format.js'
import { useUserModel } from '../../composables/useUserModel.js'

// 钱包连接态由壳 connect 域下传：密钥操作按钮的 disabled 判据（切刀曾漏供，静默坏）
defineProps({
  connected: { type: Boolean, default: false },
})

const {
  items,
  keySaving,
  discovering,
  configLoading,
  customCount,
  hasAnyConfig,
  credentialRefFor,
  fetchConfigStatus,
  toggleExpand,
  addItem,
  removeItem,
  addModel,
  removeModel,
  validateAll,
  saveConfig,
  discoverItem,
  clearOfficialKey,
  resetConfig,
} = useUserModel()
</script>

<template>
  <div class="tab-head">
    <h4>{{ $t('user.modelConfig') }}</h4>
    <p class="tab-hint">{{ $t('user.modelConfigHint') }}</p>
  </div>
  <div class="key-config">
    <!-- 获取提供方配置的 loading -->
    <div v-if="configLoading" class="config-loading">
      <div class="mini-spinner"></div>
      <span>{{ $t('user.configLoading') }}</span>
    </div>

    <!-- 提供方列表：DeepSeek 官方也是其中一个 item -->
    <template v-else>
      <div v-for="(item, idx) in items" :key="item.route || `new-${idx}`" class="provider-row">
        <div class="row-head">
          <span class="row-identity">
            <span class="row-name" :class="{ 'row-name-missing': !item.keyConfigured }">
              {{ item.displayName }}
            </span>
            <span v-if="item.kind === 'custom'" class="row-tag">{{ $t('user.customTag') }}</span>
            <span
              class="cred-dot"
              :class="item.keyConfigured ? 'ok' : 'missing'"
              :title="item.keyConfigured ? $t('user.keyConfigured') : $t('user.keyNotConfigured')"
            ></span>
            <span
              v-if="item.kind === 'official'"
              class="key-state"
              :class="item.keyConfigured ? 'ok' : 'missing'"
            >
              {{ item.keyConfigured ? $t('user.configured') : $t('user.notConfigured') }}
            </span>
          </span>
          <span class="row-actions">
            <button class="btn btn-small" @click="toggleExpand(idx)">
              {{ item.expanded ? $t('user.collapse') : $t('user.edit') }}
            </button>
            <button
              v-if="item.removable"
              class="btn btn-small btn-danger"
              :disabled="!connected || keySaving"
              @click="removeItem(idx)"
            >
              {{ $t('user.delete') }}
            </button>
          </span>
        </div>

        <div v-if="item.expanded" class="row-body">
          <input
            v-if="item.kind === 'custom'"
            v-model="item.displayName"
            :placeholder="$t('user.placeholderDisplayName')"
            :disabled="!connected || keySaving"
          />
          <input
            v-if="item.kind === 'custom'"
            v-model="item.baseURL"
            type="text"
            :placeholder="$t('user.placeholderBaseUrl')"
            :disabled="!connected || keySaving"
          />
          <input
            v-model="item.apiKey"
            type="password"
            :placeholder="
              item.keyConfigured ? $t('user.placeholderKeyKeep') : $t('user.placeholderKey')
            "
            :disabled="!connected || keySaving"
          />
          <!-- 官方：可单独删除 key（不影响自定义端点） -->
          <div v-if="item.kind === 'official' && item.keyConfigured" class="official-key-actions">
            <button
              class="btn btn-small btn-danger"
              :disabled="!connected || keySaving"
              @click="clearOfficialKey"
            >
              {{ $t('user.deleteOfficialKey') }}
            </button>
            <span class="hint">{{ $t('user.deleteOfficialKeyHint') }}</span>
          </div>
          <!-- 官方：固定端点 + 默认模型；检测到旧覆盖残留时警告并在保存时清除 -->
          <div
            v-if="item.kind === 'official'"
            class="override-warning"
            v-show="item.officialOverride"
          >
            {{ $t('user.officialOverrideWarn') }}
            <span v-if="item.officialBaseURL" class="override-url">{{ item.officialBaseURL }}</span>
            {{ $t('user.officialOverrideTail') }}
            <code>https://api.deepseek.com</code>
          </div>
          <div v-if="item.kind === 'official'" class="hint">
            {{ $t('user.officialEndpointHint') }}
          </div>
          <div v-if="item.kind === 'custom'" class="models-editor">
            <div class="models-header">
              <span>{{ $t('user.modelsTitle') }}</span>
              <button
                class="btn btn-small"
                :disabled="!connected || keySaving || discovering === idx || !item.baseURL"
                @click="discoverItem(idx)"
              >
                {{ discovering === idx ? $t('user.discovering') : $t('user.discoverBtn') }}
              </button>
            </div>
            <div v-if="!item.baseURL" class="hint">
              {{ $t('user.discoverHint') }}
            </div>
            <table v-if="item.baseURL" class="models-table">
              <thead>
                <tr>
                  <th>{{ $t('user.colModelId') }}</th>
                  <th>{{ $t('user.colName') }}</th>
                  <th>{{ $t('user.colContext') }}</th>
                  <th>{{ $t('user.colMaxTokens') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(m, mi) in item.models" :key="mi">
                  <td><input v-model="m.id" placeholder="model-id" /></td>
                  <td>
                    <input v-model="m.name" :placeholder="$t('user.placeholderModelName')" />
                  </td>
                  <td>
                    <input
                      v-model.number="m.contextWindow"
                      type="number"
                      min="1"
                      placeholder="128000"
                    />
                  </td>
                  <td>
                    <input v-model.number="m.maxTokens" type="number" min="1" placeholder="8192" />
                  </td>
                  <td>
                    <button class="btn btn-small btn-danger" @click="removeModel(idx, mi)">
                      ✕
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            <button
              class="btn btn-small"
              :disabled="!connected || keySaving"
              @click="addModel(idx)"
            >
              {{ $t('user.addModel') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 添加提供方 -->
      <div class="add-actions">
        <button
          class="btn btn-small"
          :disabled="!connected || keySaving || customCount >= 20"
          @click="addItem"
        >
          {{ $t('user.addEndpoint') }}
        </button>
      </div>
    </template>

    <style scoped>
      .action-hints {
        margin-top: 1rem;
        padding: 1rem;
        background: var(--bg-page);
        border-radius: 12px;
        border: 1px solid var(--surface-soft);
      }

      .add-actions {
        display: flex;
        gap: 8px;
        margin: 4px 0 12px;
      }

      .key-config input {
        width: 100%;
        padding: 0.625rem 0.85rem;
        border: 1px solid var(--border-light);
        border-radius: 10px;
        font-size: 0.9rem;
        margin-bottom: 0.75rem;
        box-sizing: border-box;
        background: var(--surface-white);
        color: var(--text-main);
      }

      .key-config input:focus {
        outline: none;
        border-color: var(--brand-text);
        box-shadow: 0 0 0 3px rgba(107, 123, 219, 0.15);
      }

      .key-state {
        font-size: 11px;
        line-height: 16px;
        font-weight: 500;
      }

      .models-editor {
        margin: 0.25rem 0 0.75rem;
        padding: 0.75rem;
        border: 1px dashed #cbd5e1;
        border-radius: 10px;
        background: var(--bg-page);
      }

      .models-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
        font-weight: 600;
        color: var(--text-body);
        font-size: 0.9rem;
      }

      .models-table {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 0.5rem;
      }

      .models-table th {
        text-align: left;
        font-size: 0.75rem;
        color: var(--text-faint);
        font-weight: 600;
        padding: 0.3rem 0.4rem;
        border-bottom: 1px solid var(--surface-soft);
        background: transparent;
      }

      .models-table td {
        padding: 0.25rem 0.4rem;
      }

      .models-table input {
        width: 100%;
        padding: 0.4rem 0.5rem;
        border: 1px solid var(--border-light);
        border-radius: 8px;
        font-size: 0.85rem;
        box-sizing: border-box;
        margin: 0;
      }

      .models-table td:last-child {
        width: 2.5rem;
        text-align: center;
      }

      .official-key-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 0.75rem;
      }

      .override-url {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        word-break: break-all;
      }

      .override-warning {
        margin-bottom: 0.75rem;
        padding: 0.5rem 0.75rem;
        border: 1px solid #fcd34d;
        border-radius: 8px;
        background: #fffbeb;
        color: #92400e;
        font-size: 0.85rem;
        line-height: 1.5;
      }

      .provider-row {
        border: 1px solid var(--border-light);
        border-radius: 12px;
        padding: 10px 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 8px;
        background: var(--surface-white);
      }

      .row-actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
      }

      .row-head {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .row-identity {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .row-name {
        font-size: 14px;
        line-height: 22px;
        font-weight: 500;
        color: var(--text-main);
      }

      .row-name-missing {
        color: var(--danger);
      }

      .row-tag {
        flex: none;
        padding: 1px 6px;
        border: 1px solid var(--border-light);
        border-radius: 4px;
        font-size: 11px;
        line-height: 16px;
        color: var(--text-muted);
      }
    </style>

    <div class="action-buttons">
      <button class="btn btn-primary" :disabled="!connected || keySaving" @click="saveConfig">
        {{ keySaving ? $t('user.saving') : $t('user.saveConfig') }}
      </button>
      <button
        class="btn btn-danger"
        :disabled="!connected || keySaving || !hasAnyConfig"
        @click="resetConfig"
      >
        {{ $t('user.resetConfig') }}
      </button>
    </div>
    <div class="action-hints">
      <div class="hint">
        <strong>{{ $t('user.saveFlowTitle') }}</strong>
        {{ $t('user.saveFlow') }}
      </div>
      <div class="hint">
        <strong>{{ $t('user.discoverFlowTitle') }}</strong>
        {{ $t('user.discoverFlow') }}
      </div>
      <div class="hint">
        <strong>{{ $t('user.resetFlowTitle') }}</strong>
        {{ $t('user.resetFlow') }}
      </div>
    </div>
  </div>
</template>
