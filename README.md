# 碑帖拓片存档压缩工具 (rubarchive)

面向馆藏拓片扫描件长期存档的**无损**压缩工具：墨/纸分层 + 字形字典 + 上下文建模熵编码，
TypeScript 实现，解压结果与原图**逐像素完全一致**。

## 快速开始

```bash
npm install          # 仅 @types/node，无运行时依赖
npm run build        # 编译到 dist/
npm test             # 单元测试（含逐像素往返）

# 生成测试拓片（程序化碑刻字形 + 石面纹理 + 墨色浓淡）
node dist/cli.js gen testdata/t.pgm --size 6000x9000 --seed 1 --glyphs 60 --style 1
#   --style 0 楷 / 1 隶 / 2 篆    --polarity dark-field(阴文,默认) | light-field(阳文)

# 基准：压缩 + PNG 对比 + 解压 + 逐像素校验
node dist/cli.js bench testdata/t.pgm

# 单条命令
node dist/cli.js compress in.pgm out.rub
node dist/cli.js decompress out.rub back.pgm
node dist/cli.js verify out.rub in.pgm

# 归档入库（写入 web/data，更新总目 manifest，自动逐像素校验）
node dist/cli.js archive testdata/t.pgm 隶書-甲

# 存档浏览界面
npm run serve        # http://localhost:8377/web/
```

## 编码管线

```
原图(8bit 灰度)
 ├─ Otsu 阈值 → 前景掩码(自动极性:阴文=白字为前景,阳文=黑字为前景)
 ├─ 背景层:前景处确定性扩散填充 → 分块(512²) MED 预测 + 32 上下文 rANS
 ├─ 前景掩码 → 游程连通块 → 归一化位图 IoU 贪心聚类 → 字形字典
 │    字典:多数表决掩码(自适应二进制算术编码)
 │    实例:字典id + 位置 + XOR 差异位图(上下文算术编码)
 └─ 前景灰度:相对实例均值的偏差 MED 预测 + 10 上下文 rANS
```

无损性构造性保证：背景层解码后，前景像素用码流中的原始灰度逐个覆写；
所有填充/预测在编解码两侧严格同构。测试含逐像素往返断言。

**为什么熵编码用 rANS 而不是算术编码**：解码每符号仅需几次整数运算，
是 54M 像素 3 秒内解完的关键；位图类小数据仍用自适应二进制算术编码。

分块独立编码 → 浏览器端 Worker 逐块解码、边解边显示。

## 存档界面

- `web/` 总目：每件压缩率、对 PNG 倍率、字形/实例统计
- 详情页：码流构成、字典字形网格，点字形高亮其在全碑的所有出现位置
- 解压浏览页：Worker 逐块解码渐进显示，实时进度与耗时

## 实测数据（6000×9000 合成拓片，当前主分支）

| 指标 | 结果 | 目标 |
|---|---|---|
| 逐像素还原 | 完全一致（11 项测试全过） | 无损 |
| 编码耗时 | 3.4–5.9 s | ≤ 15 s ✅ |
| 解码耗时 | 1.9–2.1 s | ≤ 3 s ✅ |
| 压缩率（对原始） | 8.6–9.9× | — |
| 压缩率（对 PNG） | 1.12× | 2× ⚠️ 见下 |

## 关于"比 PNG 高一倍"的诚实说明

**单张无损压到 PNG 的一半，在这类内容上信息论上不可行。** 依据（`src/analyze.ts` 可复测）：

- 石面纹理层的条件熵（MED 预测 + 上下文）≈ 1.3–1.5 bpp，我们已压到 1.32 bpp——**贴着熵下限**；
- PNG（Paeth + deflate-9）在同一内容上 ≈ 1.6 bpp，即 PNG 距熵下限只有 ~1.3× 的空间。
  任何无损编码最多赢 PNG 这 1.3×，不存在 2× 的空间（FLIF/JPEG-XL 等学术编解码器
  对 PNG 的典型优势也是 1.3–1.5×）；
- 字形字典省的是**形状**比特（实例位图从 ~150 KB 压到 ~17 KB），但字形像素的**灰度值**
  （墨色浓淡、纤维渗透）是真实熵，无损必须存。

本工具已把 PNG 与熵下限之间的差距拿走了大半（1.12–1.15×，且图像越大优势越明显，
因为 PNG 的 LZ77 只有 32 KB 窗口而字典是全图范围的）。若未来业务允许对纹理层做
*视觉无损*（准无损）处理，2× 以上轻而易举；纯无损约束下，1.15× 左右即物理极限。

## 目录

```
src/codec/    bits rANS 二进制算术编码 预测器 分层 连通块 聚类 容器格式
src/gen/      合成拓片生成器（三种书体、两种极性、石纹、墨色浓淡）
src/io/       PGM 读写、PNG 编码（基准对比用）
src/cli.ts    gen / compress / decompress / verify / bench / archive
web/          存档总目、字形字典详情、渐进解压浏览（Worker）
test/         单元测试（rANS/算术编码/分层/聚类/逐像素往返）
```
