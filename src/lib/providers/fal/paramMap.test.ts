import { describe, expect, it } from 'vitest'

import type { HairInput, ImageInput, TryOnInput } from '../types'
import {
  ENDPOINT_MAPPINGS,
  getImageFields,
  mapParams,
  TaskKindMismatchError,
  UnsupportedEndpointError,
} from './paramMap'

const FASHN = 'fal-ai/fashn/tryon/v1.6'
const APP_TRYON = 'fal-ai/image-apps-v2/virtual-try-on'
const HAIR = 'fal-ai/image-apps-v2/hair-change'

function image(name: string): ImageInput {
  return { bytes: Buffer.from(name), mime: 'image/webp', filename: `${name}.webp` }
}

const PERSON_URL = 'https://fal.media/person.webp'
const GARMENT_URL = 'https://fal.media/garment.webp'

const tryOnInput: TryOnInput = {
  kind: 'tryon',
  person: image('person'),
  garment: image('garment'),
  category: 'tops',
  mode: 'quality',
  garmentPhotoType: 'flat-lay',
}

const hairInput: HairInput = {
  kind: 'hair',
  person: image('person'),
  hairstyle: 'bob_cut',
  color: 'balayage',
}

describe('mapParams', () => {
  describe('fashn/tryon/v1.6', () => {
    it('使用该端点自己的参数名', () => {
      const result = mapParams(FASHN, tryOnInput, {
        person: PERSON_URL,
        garment: GARMENT_URL,
      })

      expect(result).toEqual({
        model_image: PERSON_URL,
        garment_image: GARMENT_URL,
        category: 'tops',
        mode: 'quality',
        // 注意这里是下划线命名，与 apps-v2 端点的 person_image_url 不同
        garment_photo_type: 'flat-lay',
      })
    })
  })

  describe('image-apps-v2/virtual-try-on', () => {
    it('参数名与 fashn 完全不同 —— 这正是映射层存在的理由', () => {
      const result = mapParams(APP_TRYON, tryOnInput, {
        person: PERSON_URL,
        garment: GARMENT_URL,
      })

      expect(result).toEqual({
        person_image_url: PERSON_URL,
        clothing_image_url: GARMENT_URL,
        // 试穿必须保留原始姿态，否则人物姿势会被上游重绘
        preserve_pose: true,
      })
    })

    it('不把 category/mode 这些该端点不支持的参数透传过去', () => {
      const result = mapParams(APP_TRYON, tryOnInput, {
        person: PERSON_URL,
        garment: GARMENT_URL,
      })

      expect(result).not.toHaveProperty('category')
      expect(result).not.toHaveProperty('mode')
      expect(result).not.toHaveProperty('garment_photo_type')
    })
  })

  describe('image-apps-v2/hair-change', () => {
    it('用枚举参数而非 prompt', () => {
      const result = mapParams(HAIR, hairInput, { person: PERSON_URL })

      expect(result).toEqual({
        image_url: PERSON_URL,
        target_hairstyle: 'bob_cut',
        hair_color: 'balayage',
      })
    })

    it('不包含任何服装相关字段', () => {
      const result = mapParams(HAIR, hairInput, { person: PERSON_URL })

      expect(result).not.toHaveProperty('garment_image')
      expect(result).not.toHaveProperty('clothing_image_url')
    })
  })

  describe('类型校验', () => {
    it('把换发型任务发给试穿端点会报错', () => {
      expect(() => mapParams(FASHN, hairInput, { person: PERSON_URL })).toThrow(
        TaskKindMismatchError,
      )
    })

    it('把试穿任务发给换发型端点会报错', () => {
      expect(() =>
        mapParams(HAIR, tryOnInput, { person: PERSON_URL, garment: GARMENT_URL }),
      ).toThrow(TaskKindMismatchError)
    })

    it('试穿端点缺少服装图 URL 时报错', () => {
      expect(() => mapParams(FASHN, tryOnInput, { person: PERSON_URL })).toThrow(/需要服装图/)
    })
  })

  describe('未登记端点', () => {
    it('抛出可读错误而不是静默返回空对象', () => {
      expect(() => mapParams('fal-ai/not-registered', hairInput, { person: PERSON_URL })).toThrow(
        UnsupportedEndpointError,
      )
    })
  })
})

describe('getImageFields', () => {
  it('试穿端点需要人物图与服装图两个字段', () => {
    expect(getImageFields(FASHN)).toEqual({
      personField: 'model_image',
      garmentField: 'garment_image',
    })
  })

  it('换发型端点只需要人物图', () => {
    const fields = getImageFields(HAIR)

    expect(fields.personField).toBe('image_url')
    expect(fields.garmentField).toBeUndefined()
  })
})

describe('映射表自检', () => {
  it('每个映射声明的 personField 都出现在自己产出的参数里', () => {
    // 防止"改了 mapParams 却忘了同步 personField"这类漂移：
    // adapter 靠 personField 判断要不要上传服装图，对不上就会传错。
    for (const [endpoint, mapping] of Object.entries(ENDPOINT_MAPPINGS)) {
      const input = mapping.kind === 'tryon' ? tryOnInput : hairInput
      const urls =
        mapping.kind === 'tryon'
          ? { person: PERSON_URL, garment: GARMENT_URL }
          : { person: PERSON_URL }

      const produced = mapParams(endpoint, input, urls)

      expect(
        Object.keys(produced),
        `${endpoint} 的 personField 与实际产出不符`,
      ).toContain(mapping.personField)
    }
  })
})
