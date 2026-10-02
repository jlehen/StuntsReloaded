// Original struct layouts (restunts c/externs.h, c/math.h, c/shape3d.h), packed. The Mindscape
// build (version.js) has no second wheel-position array in CARSTATE (so GAMESTATE is 0x430 bytes)
// and no frame rate in the replay header.
import { struct, A, G } from './mem.js';
import { MS } from './version.js';

export const VECTOR = struct([['x', 'i16'], ['y', 'i16'], ['z', 'i16']], 6);
export const VECTORLONG = struct([['lx', 'i32'], ['ly', 'i32'], ['lz', 'i32']], 12);
export const POINT2D = struct([['px', 'i16'], ['py', 'i16']], 4);
export const RECTANGLE = struct([['left', 'i16'], ['right', 'i16'], ['top', 'i16'], ['bottom', 'i16']], 8);
// vals[] order: _11 _21 _31 _12 _22 _32 _13 _23 _33 (column-major).
export const MATRIX = struct([['vals', 'i16', 9]], 18);
export const M11 = 0, M21 = 1, M31 = 2, M12 = 3, M22 = 4, M32 = 5, M13 = 6, M23 = 7, M33 = 8;
export const PLANE = struct([
  ['plane_yz', 'i16'], ['plane_xy', 'i16'], ['plane_origin', VECTOR], ['plane_normal', VECTOR], ['plane_rotation', MATRIX],
], 34);

export const CARSTATE = struct([
  ['car_posWorld1', VECTORLONG], ['car_posWorld2', VECTORLONG], ['car_rotate', VECTOR],
  ['car_pseudoGravity', 'i16'], ['car_steeringAngle', 'i16'], ['car_currpm', 'i16'], ['car_lastrpm', 'i16'],
  ['car_idlerpm2', 'i16'], ['car_speeddiff', 'i16'], ['car_speed', 'u16'], ['car_speed2', 'u16'],
  ['car_lastspeed', 'u16'], ['car_gearratio', 'u16'], ['car_gearratioshr8', 'u16'], ['car_knob_x', 'i16'],
  ['car_36MwhlAngle', 'i16'], ['car_knob_y', 'i16'], ['car_knob_x2', 'i16'], ['car_knob_y2', 'i16'],
  ['car_angle_z', 'i16'], ['car_40MfrontWhlAngle', 'i16'], ['field_42', 'i16'], ['car_demandedGrip', 'i16'],
  ['car_surfacegrip_sum', 'i16'], ['field_48', 'i16'], ['car_trackdata3_index', 'i16'],
  ['car_rc1', 'i16', 4], ['car_rc2', 'i16', 4], ['car_rc3', 'i16', 4], ['car_rc4', 'i16', 4], ['car_rc5', 'i16', 4],
  ['car_whlWorldCrds1', VECTOR, 4], ...(MS ? [] : [['car_whlWorldCrds2', VECTOR, 4]]),
  ['car_vec_unk3', VECTOR], ['car_vec_unk4', VECTOR], ['car_vec_unk5', VECTOR],
  ['field_B6', 'i16'], ['field_B8', 'i16'], ['field_BA', 'i16'],
  ['car_is_braking', 'i8'], ['car_is_accelerating', 'i8'], ['car_current_gear', 'i8'],
  ['car_sumSurfFrontWheels', 'i8'], ['car_sumSurfRearWheels', 'i8'], ['car_sumSurfAllWheels', 'i8'],
  ['car_surfaceWhl', 'i8', 4], ['car_engineLimiterTimer', 'i8'], ['car_slidingFlag', 'i8'], ['field_C8', 'i8'],
  ['car_crashBmpFlag', 'i8'], ['car_changing_gear', 'i8'], ['car_fpsmul2', 'i8'], ['car_transmission', 'i8'],
  ['field_CD', 'i8'], ['field_CE', 'i8'], ['field_CF', 'i8'],
], MS ? 0xb8 : 0xd0);

export const GAMESTATE = struct([
  ['game_longs1', 'i32', 24], ['game_longs2', 'i32', 24], ['game_longs3', 'i32', 24],
  ['game_vec1', VECTOR, 2], ['game_vec3', VECTOR], ['game_vec4', VECTOR],
  ['game_frame_in_sec', 'i16'], ['game_frames_per_sec', 'i16'], ['game_travDist', 'i32'],
  ['game_frame', 'i16'], ['game_total_finish', 'i16'], ['field_144', 'i16'], ['game_pEndFrame', 'i16'],
  ['game_oEndFrame', 'i16'], ['game_penalty', 'i16'], ['game_impactSpeed', 'u16'], ['game_topSpeed', 'u16'],
  ['game_jumpCount', 'i16'], ['playerstate', CARSTATE], ['opponentstate', CARSTATE],
  ['field_2F2', 'i16'], ['field_2F4', 'i16'], ['game_startcol', 'i16'], ['game_startcol2', 'i16'],
  ['game_startrow', 'i16'], ['game_startrow2', 'i16'],
  ['field_2FE', 'i16', 24], ['field_32E', 'i16', 24], ['field_35E', 'i16', 24], ['field_38E', 'i16', 24],
  ['field_3BE', 'i8', 48], ['kevinseed', 'u8', 6], ['field_3F4', 'i8'], ['game_inputmode', 'i8'],
  ['game_3F6autoLoadEvalFlag', 'i8'], ['field_3F7', 'i8', 2], ['field_3F9', 'i8'], ['field_3FA', 'i8', 48],
  ['field_42A', 'i8'], ['field_42B', 'i8', 24], ['field_443', 'i8', 24],
  ['field_45B', 'i8'], ['field_45C', 'i8'], ['field_45D', 'i8'], ['field_45E', 'i8'], ['field_45F', 'i8'],
], MS ? 0x430 : 0x460);

export const SIMD = struct([
  ['num_gears', 'i8'], ['simd_unk', 'i8'], ['car_mass', 'i16'], ['braking_eff', 'i16'], ['idle_rpm', 'i16'],
  ['downshift_rpm', 'i16'], ['upshift_rpm', 'i16'], ['max_rpm', 'i16'], ['gear_ratios', 'u16', 7],
  ['knob_points', POINT2D, 7], ['aero_resistance', 'i16'], ['idle_torque', 'i8'], ['torque_curve', 'i8', 104],
  ['field_A3', 'i8'], ['grip', 'i16'], ['field_A6', 'i16', 7], ['sliding', 'i16'], ['surface_grip', 'i16', 4],
  ['simd_unk3', 'i8', 10], ['collide_points', POINT2D, 2], ['car_height', 'i16'], ['wheel_coords', VECTOR, 4],
  ['steeringdots', 'i8', 62], ['spdcenter', POINT2D], ['spdnumpoints', 'i16'], ['spdpoints', 'i8', 208],
  ['revcenter', POINT2D], ['revnumpoints', 'i16'], ['revpoints', 'i8', 256], ['aerorestable', 'u32'],
], 0x308);

export const GAMEINFO = struct([
  ['game_playercarid', 'u8', 4], ['game_playermaterial', 'i8'], ['game_playertransmission', 'i8'],
  ['game_opponenttype', 'i8'], ['game_opponentcarid', 'u8', 4], ['game_opponentmaterial', 'i8'],
  ['game_opponenttransmission', 'i8'], ['game_trackname', 'u8', 9], ...(MS ? [] : [['game_framespersec', 'u16']]),
  ['game_recordedframes', 'u16'],
], MS ? 0x18 : 0x1a);

// Near pointers (DS offsets) are u16.
export const TRKOBJINFO = struct([
  ['si_noOfBlocks', 'i8'], ['si_entryPoint', 'i8'], ['si_exitPoint', 'i8'], ['si_entryType', 'i8'],
  ['si_exitType', 'i8'], ['si_arrowType', 'i8'], ['si_arrowOrient', 'i16'], ['si_cameraDataOffset', 'u16'],
  ['si_opp1', 'i8'], ['si_opp2', 'i8'], ['si_opp3', 'i8'], ['si_oppSpedCode', 'i8'],
], 14);
export const TRACKOBJECT = struct([
  ['ss_trkObjInfoPtr', 'u16'], ['ss_rotY', 'i16'], ['ss_shapePtr', 'u16'], ['ss_loShapePtr', 'u16'],
  ['ss_ssOvelay', 'u8'], ['ss_surfaceType', 'i8'], ['ss_ignoreZBias', 'i8'], ['ss_multiTileFlag', 'i8'],
  ['ss_physicalModel', 'i8'], ['scene_unk5', 'i8'],
], 14);
export const SHAPE3D = struct([
  ['shape3d_numverts', 'u16'], ['shape3d_verts', 'u32'], ['shape3d_numprimitives', 'u16'],
  ['shape3d_numpaints', 'u16'], ['shape3d_primitives', 'u32'], ['shape3d_cull1', 'u32'], ['shape3d_cull2', 'u32'],
], 22);

// Views on the original globals.
export const state = new GAMESTATE(A.state);
export const simd_player = new SIMD(A.simd_player);
export const simd_opponent = new SIMD(A.simd_opponent);
export const gameconfig = new GAMEINFO(A.gameconfig);

// Simulation rate: 20 frames per second, or 10 with Broderbund's slow-machine setting (the
// Mindscape build has no such setting, nor the globals behind it).
export const fps = MS ? () => 20 : () => G.framespersec;
