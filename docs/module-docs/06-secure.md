# 模块 06：`internal/secure/` — 加密存储

## 功能概述

为敏感值（如 llama-server API Key）提供 AES-256-GCM 加密，密钥以随机 32 字节文件（`data/.secret`，权限 0600）形式存储，实现密钥不落地明文。

## 核心职责

1. 敏感值加密存储
2. 密钥文件自动生成与管理
3. 加密/解密操作

## 关键数据结构

### `Encrypt` / `Decrypt`
```go
func Encrypt(keyPath, plaintext string) (string, error)
func Decrypt(keyPath, encoded string) (string, error)
```

## 核心实现细节

### 1. 密钥管理（`loadOrCreateKey`）

```go
func loadOrCreateKey(path string) ([]byte, error) {
    // 1. 若密钥文件存在且为 32 字节 → 直接返回
    // 2. 否则生成随机 32 字节密钥
    // 3. 创建目录（权限 0700）
    // 4. 写入密钥文件（权限 0600）
}
```

**特点**：
- 首次使用自动生成密钥
- 密钥文件权限严格限制（0600）
- 目录权限严格限制（0700）

### 2. 加密（`Encrypt`）

```go
func Encrypt(keyPath, plaintext string) (string, error) {
    key := loadOrCreateKey(keyPath)
    block := aes.NewCipher(key)  // AES-256
    gcm := cipher.NewGCM(block)
    nonce := random 12 bytes
    sealed := gcm.Seal(nonce, nonce, plaintext, nil)
    return base64.StdEncoding.EncodeToString(sealed)
}
```

**特点**：
- AES-256-GCM（认证加密）
- 随机 nonce（每次加密不同）
- base64 编码输出

### 3. 解密（`Decrypt`）

```go
func Decrypt(keyPath, encoded string) (string, error) {
    if encoded == "" { return "", nil }
    key := loadOrCreateKey(keyPath)
    data := base64.Decode(encoded)
    gcm := cipher.NewGCM(aes.NewCipher(key))
    nonce, ciphertext := data[:nonceSize], data[nonceSize:]
    plain := gcm.Open(nil, nonce, ciphertext, nil)
    return string(plain), nil
}
```

**特点**：
- 空输入返回空字符串
- 缺失/错误密钥返回错误（调用方可视为"无可用的密钥"）
- 密文过短返回错误

## 设计亮点

- **密钥不落地明文**：密钥文件权限严格限制
- **认证加密**：AES-256-GCM 防篡改
- **随机 nonce**：每次加密结果不同
- **健壮错误处理**：明确区分"无密钥"和"解密失败"

## 应用场景

- API Key 加密存储（`data/config.json`）
- 按需解密回显 / 一键复制 / 自动填入
- Brave/Tavily 搜索 API Key

## 相关调用方

- `cmd/server/main.go`：配置读写
- `websearch/`：搜索 API Key
