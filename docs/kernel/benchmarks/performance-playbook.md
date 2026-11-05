# 内核性能工作手册

写给接手性能工作的人。报告记录"做了什么、结果如何"；这里记录"怎么测才可信、哪些路走不通、问题要怎么定位"。开始之前先读这份，能省下不少返工。

依据是 2026-11-03 至 11-05 的工作，涉及的提交都在主干上。

## 1. 资料地图

| 想知道 | 看哪里 |
|---|---|
| 这批工作的结论、改动和待决事项 | [优化总结](1103-optimization-summary.md) |
| 每个指标的瓶颈、可选做法和损益 | [第二轮报告](1103-round2-performance-report.md) |
| 场景仿真体系和 Linux 启动阶段拆解 | [1103 报告](1103-kernel-performance-report.md)、[仿真说明](../simulation.md) |
| 本地命令的门槛，一次变慢的归因和收回 | [1105 报告](1105-local-command-gate-report.md) |
| 决策的来龙去脉 | 技术方案 §1.4、§9.3、D-91、D-96、D-97、D-98、D-99、Q-19、Q-20、Q-92、Q-96 |

| 工具（`tools/bench/`） | 用途 | 平台 |
|---|---|---|
| `ratchet.py` | 两个构建全矩阵交替对照，给出中位数、p 值和退化项 | macOS；可经 ssh 带上 Linux |
| `local_ab.py` | 本地命令的多版本对照：每个版本多份拷贝，给出耗时和缺页 | Linux |
| `bench_cli.py`、`local-command-budget.json` | CI 的本地命令门槛：缺页预算和最快一次的耗时 | 门槛只在 Linux 上生效 |
| `fault_trace.py` | 一条命令的每次缺页归到哪个段、是读是写：读内核的 tracepoint，什么都不用装 | Linux，root |
| `bench_startup.py`、`bench_protocol_startup.py`、`startup_launcher.c` | CLI、ACP、socket 到首个模型请求的耗时 | 两者；原生计时器只用于 Linux |
| `mem_once.py` | 一次启动的峰值内存（本地模拟模型，不花钱） | 两者 |
| `mem_real.py` | 和对照程序连真实服务商比较内存；key 从环境变量读 | 两者 |
| `mem_stages.py` | 启动、initialize、建会话、任务完成各阶段的内存 | 两者 |
| `mem_live_heap.py` | 活着的堆分配按调用位置排序 | macOS |
| `mem_alloc_events.py` | 全部分配（含已释放）按调用位置排序 | macOS |
| `mem_retention.py` | 任务结束后内存随时间的变化 | macOS |
| `memrun.c` | Linux 上量子进程峰值 RSS 的包装器（原因见 §3） | Linux |
| `sample_hotspots.py` | 解析 macOS `sample` 的结果：自身时间、包含时间、某个叶子函数的调用者 | macOS |
| `finx-sim`、`finx-load`（`crates/finx-bench`） | 负载：场景仿真；压力场景与长任务 churn | 两者 |

## 2. 工作规则

- **改动不许造成可复现的退化**，也不能影响用户体验和功能。确实要做取舍的（比如 D-96 用内存换延迟和可靠性），把数字摆出来让负责人决定。
- **基线和候选交替运行**，用同一个驱动，取中位数并做显著性检验。不要跑完一个再跑另一个，机器负载会变。
- **负载类每边至少 6 次**。D-96 的前 6 对显示 P95 −11%，再跑 6 对只有 −1%，合计 −5%。3 次的结果基本不能下结论。
- **启动类指标，一份文件只算一个样本**。字节相同的两份拷贝能差 3%～5%，跑再多次也不变（见 §3）。每个版本用多份新拷贝，比较各份的中位数。曾有一项一轮 +2.1%（p=0.04）、下一轮 −2.5%，当时归因于重编改变布局，多半是这个原因。
- **指标多了必有假阳性**。一次对照约 50 项，p<0.05 时平均约 2.5 项纯属巧合。判断要结合机理：只减少分配的改动让某一项"变慢"，先怀疑噪声，再复测。
- **先确认工作量真的减少了，而不只是挪了地方**（见 §4 延迟打开日志文件）。
- **先测两个不改逻辑的版本，量出这次对比自身的噪声**。基线加一行无关代码重编，和基线比一遍。差得比候选还大，就不要下结论。
- **机器常被占用**。开跑前看 `uptime`。其他会话的 iOS 模拟器，以及构建后 Spotlight 索引新文件（`mds_stores`），都能把负载推到 30 以上。

## 3. 测量陷阱

| 现象 | 原因 | 做法 |
|---|---|---|
| Linux 上连 `/usr/bin/true` 的峰值 RSS 都是 20 MiB | `ru_maxrss` 跨 exec 保留，子进程带着 fork 前 Python 的 RSS | 用 `memrun.c` 隔一层 |
| Linux 的 `Private_Dirty` 突然变成 12.87 MiB | 刚拷过去的二进制还是脏的文件缓存，代码页被算进去 | 看 `Anonymous`，或等写回后再测 |
| Linux RSS 比预期大很多，却没有几次缺页 | 主要是二进制的代码页，由文件缓存承载，多进程共用（内核还会顺带映射相邻页，这一点是推断，未单独验证） | RSS 不等于真实开销。比较进程自身用 `Anonymous` |
| macOS 上 RSS 看着吓人 | 包含系统框架的共享页 | 看物理占用（`/usr/bin/time -l` 的 peak memory footprint，即活动监视器的数字） |
| `/usr/bin/time -l` 显示 `finx --version` 的指令数比 `true` 还少 | 短进程的这个计数不可信 | 启动对比不用它。长负载的指令数用 `finx-load` 的报告 |
| 满载时 session/new 高达几十上百 ms | 所有会话共用驱动的一条连接，回复排在流式事件后面，任务越快它越慢 | 看服务端处理要用 `--connection-per-session`。共用连接模式代表一个窗口多个会话，两者都保留 |
| `finx-load --scenario churn` 像卡死，CPU 接近 0 | 默认首包 300 ms、每块 15 ms，3000 轮要半个多小时 | 加 `--ttft-ms 0 --chunk-ms 0` |
| `sample` 的调用树是空的 | 采到了上次留下的孤儿 `finx serve`：杀 `finx-load` 不会带走子进程 | 用 `pgrep -n`，并清理旧进程 |
| 采样时负载测试失败，报 ECONNREFUSED | `sample` 暂停进程，监听队列（macOS 上限 128）被占满，Unix socket 直接拒绝 | 驱动要退避重试（protocol-design §8.2，`finx-sim` 已做）；采样那次的延迟数据不要用 |
| 采样里 `fcntl`、`write` 占比很高 | 样本包含阻塞等待，不等于 CPU | 结合 CPU 和吞吐一起判断 |
| `MallocStackLogging=1` 看不到已释放的分配 | 这个值只保留活着的分配 | 用 `MallocStackLogging=full` |
| 开了分配记录后物理占用变大（4.9 → 7.4 MiB） | 记录本身占内存 | 这时只看各调用位置的相对大小，总量另跑一次干净的 |
| ACP 进程内存涨到 2.1 GB | 用 `/dev/zero` 当 stdin，而 stdio 传输不限制单行长度（未修） | 让它空等要接一个不发数据的管道：`sleep 20 \| finx acp`。这同时是个真实缺陷 |
| 新编译的二进制第一次慢几百毫秒 | macOS 首次运行要做校验 | 先跑一次 `--version` 预热 |
| 本地模拟任务和真实任务的数字差很多 | 本地是明文 HTTP，没有 TLS、HTTP/2 和证书校验；`bench_startup` 的模拟服务还每次关连接，所以每个请求都带一次建连 | macOS 上 exec 模拟 3.23 MiB，真实 4.16 MiB。内存结论要用真实任务复核 |
| 两个二进制的启动相差 3.6%，p ≈ 0，它们却逐字节相同 | 不同文件占不同的物理页（推断）。上一个进程跑的是同一份文件时快 6%；各份拷贝之间的标准差 1.7%，重新拷贝后数字会变 | 每个版本多份新拷贝，比较各份的中位数，相邻两次不用同一份文件。`local_ab.py` 和 `ratchet.py` 的启动对比都已这样做 |
| 每个版本 6 份拷贝，同一个二进制还报出退化，单项 +18%（macOS，每份 15 次） | 每份次数少，中位数不稳。每边 6 份时，一项指标碰巧 p<0.05 且变差的概率固定约 2%，只有中位数够稳，2% 的变差线才滤得掉 | 每份 100 次（`ratchet.py`、`local_ab.py` 的默认值），数字见 [1105 报告 §6](1105-local-command-gate-report.md)。这时仍有约十分之一的轮次报出 1 项，先重跑：下一轮换了拷贝，碰巧的不会再现 |
| CI 上同一个二进制的本地命令耗时相差 18%～60% | runner 的基线分两档（约 0.45 / 0.6 ms），一轮之内还有短时拖尾 | 不用 CI 的耗时判断快慢，看缺页数 |
| 固定机器上 `status` 190 次缺页，CI 上 300 次，CI 上的新问题在固定机器上看不到 | zig 交叉编译的是非 PIE，malloc 也是 zig 自己的；CI 是静态 PIE 加 musl 的 mallocng。Excel 合入在 zig 版上只多 2 次缺页，在 CI 上多 310 次 | 对照 CI 的数字，用 §8 里和 CI 同样的链接方式。用 zig 版的旧数字时记得它们不是一种二进制（[1105 报告 §8](1105-local-command-gate-report.md)） |
| Linux 的 `Anonymous` 同一个二进制时而 0.75 MiB，时而 2.8 MiB | Debian 默认透明大页 `always`。线程栈的映射碰巧 2 MiB 对齐时，第一次写就整块映射 2 MiB。对齐与否看地址随机化，所以时有时无 | 看 `smaps_rollup` 的 `AnonHugePages`。要比较进程自己的内存，启动前调 `prctl(PR_SET_THP_DISABLE)`，这个设置能跨 exec |
| 打点版本上省了 91 µs，正式构建只省 40 µs | 打点的开销和单份拷贝的偏差都算了进去 | 打点只用来定位。收益要用不打点的构建、多份拷贝来量 |
| 2 次运行就发现"内存翻倍"（1.72 MiB） | 离群值，15 次中位数是 0.72 MiB | 内存也要多跑取中位数 |
| 对照程序的自定义连接不生效 | 它的 0.0.16 版只读 `$HOME/.fx`，`FX_HOME` 是之后才加的 | 用临时 HOME。全新目录每次都会触发后台升级，要设 `FX_AUTO_UPGRADE=0` |

## 4. 走不通的路

| 当时的想法 | 怎么证伪的 | 结论 |
|---|---|---|
| 启动慢是 clap 计算慢 | 同一进程里第一次解析 557 µs，之后每次 34 µs | 成本是冷代码首次执行。一次 `exec` 有 389 次缺页，空进程 56 次。优化方向是少执行代码，不是改算法 |
| musl 的 malloc 拖慢启动，换 mimalloc | 阶段对比：总耗时 +21%～+28%，进程装载多 0.5 ms，参数解析没变快 | 不换。macOS 上之前也试过，内存更差。**注意**：这次对比的基线是 zig 交叉编译的版本，它的 malloc 是 zig 自己的，不是 musl 的（§3）。正式的 Linux 版如果不用 zig，这一条要重测 |
| 延迟打开日志文件能省启动时间 | 全矩阵对照：socket 的 session/new 慢 20–55 µs，首请求没变快 | 工作只是从启动挪到了第一行日志到来时，已撤回（`7b48695`）。留下的是真正省掉解析的固定级别 |
| `notify` 链接 CoreServices 是 700 个镜像的元凶 | 空的 C 程序分别链接：只链接 CoreFoundation 或 Security 就已是 704 个，CoreServices 只多约 0.1 ms | 根子是证书校验要用的 Security，不是文件监听 |
| 系统框架只多约 0.4 MiB | 后来看全部分配事件：ObjC 的 `load_images` 在堆上约 490 KiB，加数据段脏页约 0.67 MiB | 实际约 1.2 MiB。只看 `vmmap` 会低估 |
| 任务后调用分配器归还内存就能降占用 | `mem_retention.py`：`malloc_zone_pressure_relief` 调用后 8 秒，占用完全不降 | macOS 的 xzone 不响应，只能减少分配本身 |
| 去掉日志订阅器的 span 存储 | 全仓库没有 span，但要复刻原格式的转义、错误来源链和 `log` 事件规整 | 只省 48 KiB，不做 |
| 每次请求不再深拷贝工具定义，能明显降单次内存 | 全部分配事件：约 30 KiB/次；要改 43 处构造点 | 对单次任务收益小，收益主要在长任务的 CPU 上，还没做 |
| 换成中位数或最快一次，2 ms 门槛就稳了 | 14 次运行重算：中位数仍失败 6 次，最快一次在慢 runner 上也到 2.13 ms | 统计量补不上两种机器的差距。门槛改看缺页（D-98） |
| 除以 `/usr/bin/true` 的基线能消掉机器差异 | `status` 与基线的比值在 2.75～4.35 之间，同一个二进制就有 3.40 和 4.35 | 不可行 |
| 启动快慢的差别来自重编后的代码布局 | 基线加一行无关代码重编两次，每个版本 6 份拷贝：首请求只差 ±0.5%，缺页只差 ±1 | 布局漂移很小。大头是单份文件的偏差（§3） |
| 少分配就一定少缺页 | ACP 的 `initialize` 少 19 次缺页，第一次 `session/new` 多 10 次，合计只少 7 次 | 早期的垃圾少了，分配器可复用的块也少了。短命令省得实在，长驻进程要降峰值才算真省 |
| 32 个空闲连接上限能控制资源 | 交替对照：任务延迟和 CPU 都变差，且让任务失败（见 §6） | 已去掉（D-96）。结合"不加未经证明的限制"的原则，这类上限要先有证据 |
| 静态链接就没有加载时的重定位 | `kernel-simulation.sh` 原来的注释这么写。静态 PIE 没有动态链接器，但自己的 `rcrt1.o` 照样重定位 | 只有非 PIE 才没有。重定位写到的每一页都是一次缺页，也都变成进程私有（D-99） |
| RELR（`-z pack-relative-relocs`）能省掉重定位的缺页 | 重定位表从 773 KB 压到 9 KB，但被写的数据页一页不少：缺页只少 3～10 次，只有 `--help` 快约 3%，其余耗时在噪声内 | 不采用。省的是表本身，贵的是写数据页。二进制小约 760 KB，以后在意体积时再看 |
| 把表格引擎放进单独的进程，启动就不用付它的代价 | 它已经跑在 `finx doc-worker` 进程里（SD-05）。代价来自同一个可执行文件里的静态数据，和代码在不在这个进程里跑无关 | 要省就得拆成另一个文件，上限是 Excel 剩下的约 46 次缺页，还要放弃单文件交付。不做（D-99） |

## 5. 定位问题的方法

**先判断问题属于哪一类，再选工具。**

1. **负载下慢**：长时间满载时采样，看非空闲线程时间。
   ```bash
   target/release/finx-sim --finx target/release/finx --protocol native --scenario macro --sessions 200 \
     --concurrency 200 --repeats 30 --settle-ms 0 --connection-per-session --json /tmp/load.json &
   sleep 2; sample "$(pgrep -n -f 'finx serve')" 3 -file /tmp/s.txt
   python3 tools/bench/sample_hotspots.py /tmp/s.txt --leaf __fcntl
   ```
2. **想知道一个瓶颈值多少**：先做一个只用于测量的变体，得到收益上限，再设计正式方案。组提交就是这样来的：把 F_FULLFSYNC 换成普通 fsync，满载吞吐翻倍，确认瓶颈后，才去找不牺牲持久性的做法。
3. **错误信息太笼统**：做一个诊断版，把错误来源链打印出来，反复跑到复现。`error sending request` 就是这样才看到底层的 ECONNRESET。
4. **启动慢**：用 1103 的阶段插桩。补丁和采集脚本在 `2026-11-03-startup-stages.json` 的 `diagnostic_sources` 里：
   ```bash
   python3 -c "import json; d=json.load(open('docs/kernel/benchmarks/2026-11-03-startup-stages.json'))['diagnostic_sources']; open('/tmp/trace.patch','w').write(d['patch']); open('/tmp/collect_startup_stages.py','w').write(d['collection_script']); open('/tmp/aggregate_startup_stages.py','w').write(d['aggregation_script'])"
   ```
   - 在单独的 worktree 里打补丁，**绝不合入**。
   - 它能干净地打在 `946c0c9` 上；在 2026-11-04 的主干（`8406344`）上，`cmd_exec`、`cmd_serve`、`kernel`、`server` 几处已经打不上，需要手工移植。
   - 采集依赖 Linux 的原生计时器，脚本要和 `bench_startup.py`、`bench_protocol_startup.py` 放在一起。
5. **本地命令变慢**：先分清是工作量还是噪声。
   1. `local_ab.py` 交替对比。耗时变了而缺页没变，多半不是工作量的变化。
   2. `fault_trace.py` 看多出来的缺页落在哪个段。落在 `.data.rel.ro`、`.rela.dyn`，而且每条命令都多同样的次数（连 `--help` 也是），是新增了带指针的静态表，这时看是谁加的表，不用看代码路径。Excel 那 310 次就是这样一次定位的。
   3. 在单独的 worktree 里加阶段打点：`clock_gettime` 加 `getrusage` 的 `ru_minflt`，存进一个全局表，进程退出前打印。打点**绝不合入**。
   4. 想知道谁碰了新页，加一个只用于诊断的计数分配器，按阶段统计次数和字节数，大块分配打印调用栈。解析器那 41 KB 就是这样找到的。
6. **内存大**：按这个顺序看。
   1. `mem_stages.py`：涨在启动、建会话还是任务？
   2. `vmmap --summary <pid>`：是堆、栈、框架数据段还是页表？和对照程序逐项比。
   3. `heap -s <pid>`：活着的堆有多少？若远小于 malloc 脏页，问题是临时分配留下的页。
   4. `mem_live_heap.py`、`mem_alloc_events.py`：具体是谁分配的。
7. **第三方依赖的成本**：`otool -L` 看链接了什么，`DYLD_PRINT_LIBRARIES=1` 数装载的镜像，用只链接该框架的空程序单独量。系统自带程序受 SIP 保护，这个环境变量对它们不生效。

## 6. 已查明的情况

**哪些是测到的，哪些是推断，接手时请区分：**

| 结论 | 依据 | 确定程度 |
|---|---|---|
| 满载瓶颈是 F_FULLFSYNC 排队 | 换普通 fsync 后吞吐翻倍；组提交结果相同 | 实测。"硬盘一次只做一个冲刷"是由此得出的推断 |
| 组提交不降低落盘保证 | Apple 手册对 fsync 和 F_FULLFSYNC 的描述；单测验证了"只有 fsync 之后才开始的冲刷才算覆盖" | **没有做过断电实测** |
| 32 个连接上限导致工具调用失败 | 基线在两组对照里反复出现 `error sending request`（一组 26 次中 2 次，一组满载 4 次中 3 次），去掉后 0 次 | 相关性很强。诊断版抓到过一次 ECONNRESET |
| 上述重置来自 macOS 监听队列溢出（128） | 并发新建连接远超 128，且只在反复重建连接时出现 | **推断**，没有抓到内核一侧的证据 |
| 跑任务本身 finx 不比对照程序多 | 分阶段测量，macOS +1.1 对 +3.0 MiB，Linux 同为 +0.6 MiB | 实测，真实 DeepSeek |
| 活跃堆远小于 malloc 脏页 | `heap`、`vmmap`：约 650 KiB 对约 2.2 MiB | 实测 |
| `finx exec` 自有内存约 1 MiB（Linux） | 它自己退出，读不到明细，按 ACP 估算 | **估算** |
| 本地命令在版本之间的耗时差异主要来自缺页 | 5 个版本 × 4 条命令，组内 R² 0.963，约 6.4 µs 一次 | 实测，只在 1 vCPU 的 Linux 上 |
| GitHub 有多种 runner 硬件 | 产物记录的 CPU 型号：EPYC 7763、9V45、9V74 | 实测 |
| 字节相同的拷贝速度不同是物理缓存造成的 | 同一 inode 的硬链接表现一致，不同拷贝不同，重新拷贝后变化 | **推断**，没有直接测缓存命中 |
| 缺页数在不同 runner 上一致 | 同一个二进制（`a47887a6`）在 EPYC 7763 和 9V45 上中位数完全相同，每轮的最小、最大值只差 ±1；耗时差 50% | 实测，所以预算可以拦截（D-98） |
| 带指针的静态表在 macOS 上也花钱 | `__DATA_CONST` 涨 1.2 MB，物理占用涨 1.2～1.4 MiB，去掉表后回落。可执行文件的目标版本是 11.0，用的是启动时一次性 rebase 的格式 | 实测。提高目标版本后能不能按需修正，没有测 |

**长任务每轮的开销**（3000 轮，约 860 万条指令、1 ms CPU）：33% 是写工具的写屏障和 rename，这是保护用户文件的（D-104），不要动；18% 是重新序列化历史（Q-96）；5% 是 bash 子进程。不牺牲安全或内存，上限约 −25%。

## 7. 基线与漂移

**基线是有保质期的。** 优化完的 `fdabc46` 到一天多后的 `8406344`，中间约 70 个提交，单次内存就涨了约 10%（模拟任务，各 15 次中位数）：

| 指标 | `fdabc46` | `8406344` |
|---|---:|---:|
| macOS `finx exec` 峰值占用 | 3.22 MiB | 3.55 MiB |
| macOS `finx acp` 峰值占用 | 3.63 MiB | 3.91 MiB |
| macOS `finx serve` 峰值占用 | 3.80 MiB | 4.17 MiB |
| Linux ACP 任务后匿名内存 | 0.72 MiB | 0.83 MiB |
| Linux `finx exec` 峰值 RSS | 12.25 MiB | 13.36 MiB |

新增来源可以用 `mem_alloc_events.py` 看，比如 `finx_core::docs` 的工具定义和模型目录。还没有逐项归因。

CI 目前只守本地命令（缺页预算加最快一次的耗时，D-98；预算 2026-11-05 填好，开始拦截），**内存和负载都没有守护**，优化成果会被新功能悄悄吃掉。开工前先重测基线，不要沿用报告里的数字。

CI 的二进制保持静态 PIE，它也是唯一能看见带指针的静态表的地方：这些表在非 PIE 上不花钱，在 macOS 上却要花内存（D-99）。

1103 两份报告里 ±3% 以内的启动差异都是单份拷贝测的，不能当成版本差异（§3）。

## 8. 环境

- **macOS**：Apple M2 Max，常被其他会话占用。
- **Linux**：1 vCPU、约 2 GiB 的 x86_64 主机。上面没有编译器，也不要在上面装工具链，在 Mac 上交叉编译后拷过去。下面的 `finx` 和 CI 的链接方式相同：静态 PIE，工具链自带的 `rcrt1.o` 和 `libc.a`，只是用 rust-lld 代替 CI 的 GNU ld。`cargo-zigbuild` 只用来编 C（`ring`、SQLite）。`libdl.a` 是空的，CI 上的 `-ldl` 找到的也是 glibc 的空存根：
  ```bash
  mkdir -p target/empty-libs && printf '!<arch>\n' > target/empty-libs/libdl.a
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C linker=rust-lld -C linker-flavor=ld.lld -C link-self-contained=yes -L native=$PWD/target/empty-libs" \
    cargo-zigbuild zigbuild --profile dist --target x86_64-unknown-linux-musl -p finx-cli --bin finx
  zig cc -target x86_64-linux-musl -O2 -static tools/bench/startup_launcher.c -o target/startup-launcher
  zig cc -target x86_64-linux-musl -O2 -static tools/bench/memrun.c -o target/memrun-linux
  ```
  需要 zig 0.17 和 cargo-zigbuild。这样编出来的缺页数和 CI 差 ±2%（`sessions` ±4%）。**不带这个 `RUSTFLAGS` 不能和 CI 的数字比**：链接由 zig 来做，出来的是非 PIE，malloc 是 zig 自己的，1103 和 1105 §1～§7 的 Linux 数字都是这样来的（§3）。正式的 Linux 版用哪种还没有定。1 vCPU 不能外推多核容量，并发结论以多核机器为准。
- **真实服务商测试**：key 只放环境变量，经 ssh 时走标准输入，不写进文件、仓库或命令历史；跑完清理临时目录。
- **主机地址和登录别名不要写进仓库。**

## 9. 接下来从哪里入手

待决事项见[优化总结 §5](1103-optimization-summary.md)。按对用户的影响，建议的优先顺序：

1. **真实模型的任务指标还是空白**：固定任务集上的成功率、每个成功任务的 token 和成本、提示缓存命中率。这些对成本和延迟的影响远大于毫秒级优化，而现在完全没有基线。
2. **把内存和负载纳入 CI 守护**，并归因 §7 的漂移。缺页预算的办法同样适用于 exec、ACP、socket 的启动：缺页数基本不受机器快慢影响。
3. **真实网络下的首包**：本地模拟测不到 DNS、TCP、TLS 建连，通常 100–300 ms。
4. **故障注入**：限流、断流、磁盘满、进程被杀后恢复、异常客户端（stdio 单行长度就是这样发现的）。
5. 启动和单次内存的继续压缩：收益已经不大，除非有明确场景。
