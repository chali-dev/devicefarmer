<script setup lang="ts">
import PageContainer from '../components/common/PageContainer.vue'
import RiskEvents from '../components/risk/RiskEvents.vue'

/** 风控记录 (风控管理, admin): what the automatic work on the phones ran into (formerly a tab of /risk). */
</script>

<template>
  <PageContainer>
    <a-card :bordered="false"><RiskEvents /></a-card>
  </PageContainer>
</template>
