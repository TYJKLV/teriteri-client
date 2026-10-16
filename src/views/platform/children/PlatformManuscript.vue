<template>
    <div class="platform-manuscript">
        <div class="page-head">
            <h3 class="title">稿件管理</h3>
            <p class="sub">
                「审核中」的稿件可以撤回，撤回后直接删除；「已通过」的稿件删除后，其他用户那边会显示为"已失效"，
                源文件也会一并删除，<b>无法恢复</b>，请谨慎操作。
            </p>
        </div>

        <!-- 状态筛选 -->
        <div class="filter-bar">
            <div class="filter-item"
                 v-for="tab in tabs" :key="tab.value"
                 :class="{ active: activeTab === tab.value }"
                 @click="activeTab = tab.value">
                {{ tab.label }}
                <span class="count">{{ countOf(tab.value) }}</span>
            </div>
        </div>

        <el-table :data="shownList"
                  v-loading="loading"
                  style="width: 100%"
                  empty-text="这里还什么都没有呢~">
            <el-table-column label="稿件" min-width="320">
                <template #default="{ row }">
                    <div class="manuscript-cell">
                        <img class="cover" :src="row.video.coverUrl" alt="">
                        <div class="info">
                            <p class="name" :title="row.video.title">{{ row.video.title }}</p>
                            <p class="descr" :title="row.video.descr">{{ row.video.descr || '（简介为空）' }}</p>
                        </div>
                    </div>
                </template>
            </el-table-column>

            <el-table-column label="分区" width="140">
                <template #default="{ row }">
                    <span class="category">{{ categoryText(row) }}</span>
                </template>
            </el-table-column>

            <el-table-column label="投稿时间" width="170">
                <template #default="{ row }">
                    <span class="time">{{ formatDate(row.video.uploadDate) }}</span>
                </template>
            </el-table-column>

            <el-table-column label="数据" width="210">
                <template #default="{ row }">
                    <span class="stat">播放 {{ num(row.stats && row.stats.play) }}</span>
                    <span class="stat">点赞 {{ num(row.stats && row.stats.good) }}</span>
                    <span class="stat">弹幕 {{ num(row.stats && row.stats.danmu) }}</span>
                </template>
            </el-table-column>

            <el-table-column label="状态" width="100">
                <template #default="{ row }">
                    <el-tag :type="statusTagType(row.video.status)" size="small" effect="light">
                        {{ statusText(row.video.status) }}
                    </el-tag>
                </template>
            </el-table-column>

            <el-table-column label="操作" width="140" fixed="right">
                <template #default="{ row }">
                    <!-- 只有过审的稿件才有公开详情页，审核中/未通过的点进去只会是 404 -->
                    <el-button v-if="row.video.status === 1" link type="primary" @click="openVideo(row)">查看</el-button>
                    <el-button link type="danger" @click="confirmRemove(row)">
                        {{ row.video.status === 0 ? '撤回' : '删除' }}
                    </el-button>
                </template>
            </el-table-column>
        </el-table>
    </div>
</template>

<script>
import { ElMessage, ElMessageBox } from 'element-plus';
import { handleNum, handleDateTime } from '@/utils/utils.js';

export default {
    name: "PlatformManuscript",
    data() {
        return {
            loading: false,
            list: [],   // 我的全部稿件（不含已删除的）
            activeTab: -1,  // 当前筛选中，-1 表示全部
            tabs: [
                { label: '全部', value: -1 },
                { label: '审核中', value: 0 },
                { label: '已通过', value: 1 },
                { label: '未通过', value: 2 },
            ],
        }
    },
    computed: {
        // 按状态筛选后要展示的稿件
        shownList() {
            if (this.activeTab === -1) return this.list;
            return this.list.filter(item => item.video.status === this.activeTab);
        }
    },
    methods: {
        // 获取自己的全部稿件：走的是专门的接口，能拿到审核中/未通过这些
        // 在个人空间投稿页（只展示已过审的）里看不到的稿件
        async getManuscripts() {
            this.loading = true;
            const res = await this.$get("/video/user-manuscripts", {
                headers: { Authorization: "Bearer " + localStorage.getItem("teri_token") },
            });
            this.loading = false;
            if (!res || !res.data) return;
            this.list = res.data.data || [];
        },

        // 撤回（审核中）或删除（已通过/未通过）稿件：后端统一走 status=3
        async removeManuscript(item) {
            const formData = new FormData();
            formData.append('vid', item.video.vid);
            formData.append('status', 3);
            const res = await this.$post('/video/change/status', formData, {
                headers: { Authorization: "Bearer " + localStorage.getItem("teri_token") },
            });
            if (!res || !res.data) return;
            if (res.data.code === 200) {
                ElMessage.success(item.video.status === 0 ? '已撤回该稿件' : '已删除该稿件');
                await this.getManuscripts();
            }
        },

        // 删除前的二次确认：这一步不可逆，标题里带上稿件名，避免误删
        confirmRemove(item) {
            const isPending = item.video.status === 0;
            ElMessageBox.confirm(
                isPending
                    ? `确定撤回《${item.video.title}》吗？撤回后该稿件会被直接删除，无法恢复。`
                    : `确定删除《${item.video.title}》吗？该操作会同时删除视频源文件与封面，无法恢复。`,
                {
                    confirmButtonText: isPending ? '撤回' : '删除',
                    cancelButtonText: '取消',
                    type: 'warning',
                }
            ).then(() => {
                this.removeManuscript(item);
            }).catch(() => {})
        },

        // 新标签页打开视频详情
        openVideo(item) {
            window.open(this.$router.resolve(`/video/${item.video.vid}`).href, '_blank');
        },

        // 统计某个状态下的稿件数量，-1 为全部
        countOf(status) {
            if (status === -1) return this.list.length;
            return this.list.filter(item => item.video.status === status).length;
        },

        // 分区文案：主分区 / 子分区
        categoryText(item) {
            const category = item.category;
            if (!category) return '-';
            return category.scName ? `${category.mcName} / ${category.scName}` : category.mcName;
        },

        // 状态 -> 文案
        statusText(status) {
            return status === 0 ? '审核中' : status === 1 ? '已通过' : status === 2 ? '未通过' : '已删除';
        },

        // 状态 -> 标签颜色
        statusTagType(status) {
            return status === 0 ? 'warning' : status === 1 ? 'success' : 'danger';
        },

        // 处理大于一万的数字
        num(number) {
            return handleNum(number || 0);
        },

        // 处理投稿时间
        formatDate(date) {
            return handleDateTime(date);
        },
    },
    mounted() {
        this.getManuscripts();
    }
}
</script>

<style scoped>
.platform-manuscript {
    padding: 20px 30px;
}

.page-head .title {
    font-size: 20px;
    font-weight: 600;
    color: #222;
    line-height: 28px;
}

.page-head .sub {
    margin-top: 8px;
    font-size: 12px;
    line-height: 20px;
    color: #99a2aa;
}

.page-head .sub b {
    color: var(--stress_red);
}

.filter-bar {
    display: flex;
    align-items: center;
    margin: 18px 0 12px;
    border-bottom: 1px solid #eee;
}

.filter-item {
    position: relative;
    padding: 0 4px 10px;
    margin-right: 26px;
    font-size: 14px;
    color: var(--text2);
    cursor: pointer;
    transition: color .2s ease;
}

.filter-item:hover {
    color: var(--brand_pink);
}

.filter-item.active {
    color: var(--brand_pink);
}

.filter-item.active:after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    background: var(--brand_pink);
}

.filter-item .count {
    margin-left: 2px;
    font-size: 12px;
    color: #99a2aa;
}

.manuscript-cell {
    display: flex;
    align-items: center;
}

.manuscript-cell .cover {
    width: 90px;
    height: 56px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: cover;
    background-color: #f4f5f7;
}

.manuscript-cell .info {
    margin-left: 12px;
    min-width: 0;
}

.manuscript-cell .name {
    font-size: 14px;
    color: #222;
    line-height: 20px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.manuscript-cell .descr {
    margin-top: 6px;
    font-size: 12px;
    color: #99a2aa;
    line-height: 18px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.category,
.time {
    font-size: 13px;
    color: var(--text2);
}

.stat {
    display: inline-block;
    margin-right: 10px;
    font-size: 12px;
    color: #99a2aa;
}
</style>
